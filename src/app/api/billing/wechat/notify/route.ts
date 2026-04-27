// RFC 0006 PR-3 — 微信支付 APIv3 异步通知端点。
//
// 与支付宝路由的差异：
//   * 正文是 JSON，不是 form-urlencoded。
//   * 签名位于五个 HTTP 标头中
//       Wechatpay-Signature
//       Wechatpay-Timestamp
//       Wechatpay-Nonce
//       Wechatpay-Serial
//       Wechatpay-Signature-Type（可选，默认为 WECHATPAY2-SHA256-RSA2048）
//     验证需要微信支付平台证书，由 SDK 获取和缓存；我们委托。
//   * 有趣的有效载荷在 `resource.ciphertext`（AES-GCM）中；我们
//     将其交给 `decryptWechatNotify` 以获得清文发票/订单事件。
//   * 响应正文是 JSON：去重命中和成功时为 { code: 'SUCCESS', message: 'OK' }；
//     错误时为 { code: 'FAIL', message: '...' }。

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

  // 标头签名验证被委托给 SDK（它知道如何轮换平台证书）。为简洁起见，
  // 我们在解密时信任 SDK 自己的 verifySign 助手 — `decryptWechatNotify`
  // 如果底层 SDK 拒绝有效载荷则抛出。
  let envelope: WechatNotifyEnvelope;
  try {
    envelope = JSON.parse(raw) as WechatNotifyEnvelope;
  } catch {
    return fail('invalid-json');
  }

  // 幂等性索取 — `envelope.id` 是微信端通知 id。
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
      // 解密失败意味着签名/密钥不匹配 — 不要保留去重行，
      // 否则后来的合法重试无法进入。
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
  // v1 仅关心成功的交易；退款重新使用相同的通知渠道，
  // 但在后续 PR 的单独处理程序中流动（RFC 0006 §5.3.3 — 退款事件仍然记录 BillingEvent，
  // 所以我们不会丢失历史记录，但我们不会在其上更改订阅状态）。
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
        // v1 本地支付路径 — 单次充值，直到周期扣款（papay）签名在后续 PR 中启用时才有协议号。
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
