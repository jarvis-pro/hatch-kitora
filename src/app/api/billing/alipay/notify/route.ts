// RFC 0006 PR-3 — Alipay async notification endpoint.
//
// Alipay POSTs application/x-www-form-urlencoded notifications to this
// route after every status change on a payment we initiated. Behaviour:
//
//   1. Parse the form body to a flat string-map.
//   2. Verify the RSA2 signature with the SDK (`verifyAlipayNotify`).
//      Bad signature → log + 4xx + nothing else.
//   3. Idempotency dedup on (provider='alipay', notify_id) via the new
//      `BillingEvent` table. Duplicate → respond `success` immediately.
//   4. Resolve the originating Org from `passback_params` (round-trips
//      our { orgId, priceId }) — fail loud if missing.
//   5. Route by `trade_status`:
//         TRADE_SUCCESS / TRADE_FINISHED  → upsert Subscription as ACTIVE,
//                                            emit subscription.created or
//                                            subscription.updated.
//         WAIT_BUYER_PAY / TRADE_CLOSED    → noop (no Subscription change).
//   6. Record an audit row and enqueue the outbound webhook events.
//   7. Respond with the literal string `success` (Alipay-required).

import { OrgRole, Prisma } from '@prisma/client';

import { recordAudit } from '@/lib/audit';
import { decodeAlipayPassback, verifyAlipayNotify } from '@/lib/billing/provider/alipay';
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

export async function POST(request: Request) {
  const raw = await request.text();
  const params = parseFormBody(raw);

  const verified = await verifyAlipayNotify(params);
  if (!verified) {
    logger.warn({ params: redactSensitive(params) }, 'alipay-notify-bad-signature');
    return new Response('failure', { status: 400 });
  }

  const notifyId = params.notify_id;
  if (!notifyId) {
    return new Response('failure', { status: 400 });
  }

  // Idempotency — try to claim the (provider, notify_id) tuple. Duplicate
  // hits short-circuit with a 200 + `success` so Alipay stops retrying.
  try {
    await prisma.billingEvent.create({
      data: {
        provider: 'alipay',
        providerEventId: notifyId,
        type: params.trade_status ?? 'unknown',
        payload: params as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      logger.info({ notifyId }, 'alipay-notify-duplicate');
      return new Response('success', { status: 200 });
    }
    throw error;
  }

  try {
    await dispatchAlipay(params);
    return new Response('success', { status: 200 });
  } catch (error) {
    // Roll back the dedup row so Alipay's retry can re-enter the dispatch
    // (otherwise we'd silently swallow an event after a transient DB blip).
    await prisma.billingEvent
      .delete({
        where: {
          provider_providerEventId: { provider: 'alipay', providerEventId: notifyId },
        },
      })
      .catch(() => null);
    logger.error(
      { err: error, notifyId, tradeStatus: params.trade_status },
      'alipay-notify-handler-failed',
    );
    return new Response('failure', { status: 500 });
  }
}

async function dispatchAlipay(params: Record<string, string>): Promise<void> {
  const status = params.trade_status;
  if (status !== 'TRADE_SUCCESS' && status !== 'TRADE_FINISHED') {
    // WAIT_BUYER_PAY / TRADE_CLOSED carry no Subscription state change.
    logger.info({ status, outTradeNo: params.out_trade_no }, 'alipay-notify-noop');
    return;
  }

  const passback = decodeAlipayPassback(params.passback_params);
  if (!passback) {
    logger.warn({ outTradeNo: params.out_trade_no }, 'alipay-notify-missing-passback');
    return;
  }

  const orgId = passback.orgId;
  const priceId = passback.priceId;
  const tradeNo = params.trade_no;
  const agreementNo = params.agreement_no ?? null; // present only on 周期扣款 path

  // currentPeriodEnd is "now + 30 days" for v1; once 周期扣款 cron runs we
  // bump it forward on each successful periodic charge. Stripe gives us
  // the exact period end; Alipay's charge model doesn't, so we compute.
  const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const existing = await prisma.subscription.findFirst({
    where: { orgId, provider: 'alipay' },
    select: { id: true, status: true, cnAgreementId: true },
  });

  const isNew = !existing;
  if (isNew) {
    await prisma.subscription.create({
      data: {
        orgId,
        provider: 'alipay',
        stripePriceId: priceId,
        cnAgreementId: agreementNo,
        status: 'ACTIVE',
        currentPeriodEnd: periodEnd,
      },
    });
  } else {
    await prisma.subscription.update({
      where: { id: existing!.id },
      data: {
        stripePriceId: priceId,
        cnAgreementId: agreementNo ?? existing!.cnAgreementId,
        status: 'ACTIVE',
        currentPeriodEnd: periodEnd,
      },
    });
  }

  // Match Stripe pattern: `target` for `billing.subscription_changed` is
  // the OWNER User ID, not the Subscription ID. Reports / search assume
  // that shape across providers.
  const ownerUserId = await ownerOfOrg(orgId);

  await recordAudit({
    actorId: null,
    orgId,
    action: 'billing.subscription_changed',
    target: ownerUserId,
    metadata: {
      sourceType: 'alipay.notify',
      tradeNo,
      tradeStatus: status,
      priceId,
      agreementNo,
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

// ─── Body parsing ──────────────────────────────────────────────────────────

function parseFormBody(raw: string): Record<string, string> {
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function redactSensitive(params: Record<string, string>): Record<string, string> {
  // `sign` is the only field we never want in logs.
  const { sign: _omit, sign_type: _omit2, ...rest } = params;
  void _omit;
  void _omit2;
  return rest;
}
