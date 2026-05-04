// RFC 0006 PR-3 — 支付宝异步通知端点。
//
// 支付宝在我们发起的付款的每次状态更改后 POST application/x-www-form-urlencoded 通知到此路由。行为：
//
//   1. 将表单正文解析为平面字符串映射。
//   2. 使用 SDK 验证 RSA2 签名（`verifyAlipayNotify`）。
//      坏签名 → 日志 + 4xx + 没有其他内容。
//   3. 通过新的 `BillingEvent` 表在 (provider='alipay', notify_id) 上去重幂等性。
//      重复 → 立即响应 `success`。
//   4. 从 `passback_params` 解析原始组织（往返我们的 { orgId, priceId }）—
//      如果缺少，失败大声。
//   5. 按 `trade_status` 路由：
//         TRADE_SUCCESS / TRADE_FINISHED  → 将订阅 upsert 为 ACTIVE，
//                                            发出 subscription.created 或
//                                            subscription.updated。
//         WAIT_BUYER_PAY / TRADE_CLOSED    → noop（无订阅更改）。
//   6. 记录审计行并排队出站 Webhook 事件。
//   7. 使用字面字符串 `success` 响应（Alipay 必需）。

import { OrgRole, Prisma } from '@prisma/client';

import { recordAudit } from '@/services/audit';
import { decodeAlipayPassback, verifyAlipayNotify } from '@/services/billing/provider/alipay';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { enqueueWebhook } from '@/services/webhooks/enqueue';
import type { WebhookEventType } from '@/services/webhooks/events';

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

  // 幂等性 — 尝试索取 (provider, notify_id) 元组。重复命中使用 200 + `success` 短路，
  // 以便支付宝停止重试。
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
    // 回滚去重行，以便支付宝的重试可以重新进入分发
    // （否则我们会在临时 DB 故障后无声地吞咽事件）。
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
    // WAIT_BUYER_PAY / TRADE_CLOSED 不带订阅状态更改。
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
  const agreementNo = params.agreement_no ?? null; // 仅在周期扣款路径上出现

  // currentPeriodEnd 对于 v1 是"现在 + 30 天"；一旦周期扣款 cron 运行，
  // 我们在每次成功的周期性费用上将其向前推进。Stripe 给我们确切的周期末；
  // 支付宝的费用模型没有，所以我们计算。
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

  // 匹配 Stripe 模式：`billing.subscription_changed` 的 `target` 是
  // OWNER 用户 ID，不是订阅 ID。报告/搜索假设跨提供商的形状。
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

// ─── 正文解析 ──────────────────────────────────────────────────────────

function parseFormBody(raw: string): Record<string, string> {
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function redactSensitive(params: Record<string, string>): Record<string, string> {
  // `sign` 是我们从不想要日志的唯一字段。
  const { sign: _omit, sign_type: _omit2, ...rest } = params;
  void _omit;
  void _omit2;
  return rest;
}
