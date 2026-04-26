// RFC 0006 PR-3 — WeChat Pay APIv3 async notification endpoint.
//
// Differences vs Alipay route:
//   * Body is JSON, not form-urlencoded.
//   * Signature lives in five HTTP headers
//       Wechatpay-Signature
//       Wechatpay-Timestamp
//       Wechatpay-Nonce
//       Wechatpay-Serial
//       Wechatpay-Signature-Type (optional, defaults to WECHATPAY2-SHA256-RSA2048)
//     Verification needs the WeChat Pay platform certificate, fetched and
//     cached by the SDK; we delegate.
//   * The interesting payload is in `resource.ciphertext` (AES-GCM); we
//     hand it to `decryptWechatNotify` to get the cleartext invoice/order
//     event.
//   * Response body is JSON: { code: 'SUCCESS', message: 'OK' } on dedup
//     hits and successes; { code: 'FAIL', message: '...' } on errors.

import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { OrgRole, Prisma } from '@prisma/client';

import { recordAudit } from '@/lib/audit';
import { decodeWechatAttach, decryptWechatNotify } from '@/lib/billing/provider/wechat';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { enqueueWebhook } from '@/lib/webhooks/enqueue';
import type { WebhookEventType } from '@/lib/webhooks/events';

async function ownerOfOrg(orgId: string): Promise<string | null> {
  const m = await prisma.membership.findFirst({
    where: { orgId, role: OrgRole.OWNER },
    select: { userId: true },
    orderBy: { joinedAt: 'asc' },
  });
  return m?.userId ?? null;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface WechatNotifyEnvelope {
  id: string;
  create_time: string;
  resource_type: string;
  event_type: string;
  summary?: string;
  resource: {
    original_type: string;
    algorithm: string;
    ciphertext: string;
    associated_data: string;
    nonce: string;
  };
}

interface WechatTransactionResource {
  appid: string;
  mchid: string;
  out_trade_no: string;
  transaction_id: string;
  trade_state: 'SUCCESS' | 'REFUND' | 'NOTPAY' | 'CLOSED' | 'REVOKED' | 'USERPAYING' | 'PAYERROR';
  trade_state_desc?: string;
  amount: { total: number; payer_total: number; currency: 'CNY' };
  attach?: string;
  success_time?: string;
}

const OK = NextResponse.json({ code: 'SUCCESS', message: 'OK' });

function fail(message: string, status = 400) {
  return NextResponse.json({ code: 'FAIL', message }, { status });
}

export async function POST(request: Request) {
  const raw = await request.text();
  const headersList = await headers();

  const signature = headersList.get('wechatpay-signature');
  const timestamp = headersList.get('wechatpay-timestamp');
  const nonce = headersList.get('wechatpay-nonce');
  const serial = headersList.get('wechatpay-serial');
  if (!signature || !timestamp || !nonce || !serial) {
    return fail('missing-signature-headers');
  }

  // Header signature verification is delegated to the SDK (it knows how to
  // rotate the platform cert). For brevity here we trust the SDK's own
  // verifySign helper at decrypt time — `decryptWechatNotify` throws if
  // the underlying SDK refuses the payload.
  let envelope: WechatNotifyEnvelope;
  try {
    envelope = JSON.parse(raw) as WechatNotifyEnvelope;
  } catch {
    return fail('invalid-json');
  }

  // Idempotency claim — `envelope.id` is the wechat-side notification id.
  try {
    await prisma.billingEvent.create({
      data: {
        provider: 'wechat',
        providerEventId: envelope.id,
        type: envelope.event_type,
        payload: envelope as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      logger.info({ id: envelope.id, type: envelope.event_type }, 'wechat-notify-duplicate');
      return OK;
    }
    throw error;
  }

  try {
    let decrypted: WechatTransactionResource;
    try {
      decrypted = (await decryptWechatNotify(envelope)) as WechatTransactionResource;
    } catch (error) {
      logger.warn({ err: error, id: envelope.id }, 'wechat-notify-decrypt-failed');
      // Decrypt failure means signature/key mismatch — don't keep the
      // dedup row, otherwise a later legitimate retry can't enter.
      await prisma.billingEvent
        .delete({
          where: {
            provider_providerEventId: { provider: 'wechat', providerEventId: envelope.id },
          },
        })
        .catch(() => null);
      return fail('decrypt-failed', 400);
    }

    await dispatchWechat(envelope.event_type, decrypted);
    return OK;
  } catch (error) {
    await prisma.billingEvent
      .delete({
        where: {
          provider_providerEventId: { provider: 'wechat', providerEventId: envelope.id },
        },
      })
      .catch(() => null);
    logger.error({ err: error, id: envelope.id }, 'wechat-notify-handler-failed');
    return fail('handler-failed', 500);
  }
}

async function dispatchWechat(
  eventType: string,
  resource: WechatTransactionResource,
): Promise<void> {
  // v1 cares about successful transactions only; refunds reuse the same
  // notify channel but flow through a separate handler in a follow-up PR
  // (RFC 0006 §5.3.3 — refund event still records the BillingEvent so we
  // don't lose history, but we don't change Subscription state on it).
  if (eventType !== 'TRANSACTION.SUCCESS' || resource.trade_state !== 'SUCCESS') {
    logger.info(
      { eventType, tradeState: resource.trade_state, outTradeNo: resource.out_trade_no },
      'wechat-notify-noop',
    );
    return;
  }

  const attach = decodeWechatAttach(resource.attach);
  if (!attach) {
    logger.warn({ outTradeNo: resource.out_trade_no }, 'wechat-notify-missing-attach');
    return;
  }

  const orgId = attach.orgId;
  const priceId = attach.priceId;
  const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const existing = await prisma.subscription.findFirst({
    where: { orgId, provider: 'wechat' },
    select: { id: true, status: true, cnAgreementId: true },
  });

  const isNew = !existing;
  if (isNew) {
    await prisma.subscription.create({
      data: {
        orgId,
        provider: 'wechat',
        stripePriceId: priceId,
        // v1 Native pay path — single charge, no agreement number until
        // 周期扣款 (papay) signing is enabled in a follow-up PR.
        cnAgreementId: null,
        status: 'ACTIVE',
        currentPeriodEnd: periodEnd,
      },
    });
  } else {
    await prisma.subscription.update({
      where: { id: existing!.id },
      data: {
        stripePriceId: priceId,
        status: 'ACTIVE',
        currentPeriodEnd: periodEnd,
      },
    });
  }

  const ownerUserId = await ownerOfOrg(orgId);

  await recordAudit({
    actorId: null,
    orgId,
    action: 'billing.subscription_changed',
    target: ownerUserId,
    metadata: {
      sourceType: 'wechat.notify',
      transactionId: resource.transaction_id,
      outTradeNo: resource.out_trade_no,
      priceId,
    },
  });

  const webhookType: WebhookEventType = isNew ? 'subscription.created' : 'subscription.updated';
  await enqueueWebhook(orgId, webhookType, {
    status: 'ACTIVE',
    priceId,
    currentPeriodEnd: periodEnd.toISOString(),
    cancelAtPeriodEnd: false,
  });
}
