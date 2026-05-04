import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { OrgRole, type SubscriptionStatus } from '@prisma/client';

import { env } from '@/env';
import { recordAudit } from '@/services/audit';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { stripe } from '@/lib/stripe/client';
import { enqueueWebhook } from '@/services/webhooks/enqueue';
import type { WebhookEventType } from '@/services/webhooks/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RELEVANT_EVENTS = new Set<Stripe.Event.Type>([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
]);

export async function POST(request: Request) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'webhook-not-configured' }, { status: 500 });
  }

  const body = await request.text();
  const headersList = await headers();
  const signature = headersList.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'missing-signature' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    logger.warn({ err: error }, 'stripe-webhook-signature-invalid');
    return NextResponse.json({ error: 'invalid-signature' }, { status: 400 });
  }

  if (!RELEVANT_EVENTS.has(event.type)) {
    return NextResponse.json({ received: true, ignored: true });
  }

  // 幂等性：Stripe 在 5xx / 超时时重试。尝试记录事件 ID；
  // 如果已存在，这会抛出并返回 200 以确认重复。
  try {
    await prisma.stripeEvent.create({
      data: { id: event.id, type: event.type },
    });
  } catch {
    logger.info({ id: event.id, type: event.type }, 'stripe-webhook-duplicate');
    return NextResponse.json({ received: true, alreadyProcessed: true });
  }

  try {
    await dispatch(event);
    return NextResponse.json({ received: true });
  } catch (error) {
    // 处理程序失败时，删除去重行，以便 Stripe 的重试可以重新进入。
    await prisma.stripeEvent.delete({ where: { id: event.id } }).catch(() => null);
    logger.error({ err: error, type: event.type, id: event.id }, 'stripe-webhook-handler-failed');
    return NextResponse.json({ error: 'handler-failed' }, { status: 500 });
  }
}

async function dispatch(event: Stripe.Event) {
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(event.data.object);

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return upsertSubscription(event.data.object, event.type);

    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed':
      logger.info({ type: event.type, id: event.id }, 'stripe-event');
      return;

    default:
      return;
  }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  // 仅订阅模式：拉取订阅以获得完整状态。
  if (session.mode !== 'subscription' || !session.subscription) return;

  const subId =
    typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
  const sub = await stripe.subscriptions.retrieve(subId);
  await upsertSubscription(sub, 'checkout.session.completed');
}

async function upsertSubscription(sub: Stripe.Subscription, sourceType: string) {
  // 解析所有者。在 PR-4 之后，唯一的来源是：
  // 1. `metadata.orgId`（由我们的结账路由始终设置）
  // 2. 反向查找 `Organization.stripeCustomerId`
  // `metadata.userId` 和 `User.stripeCustomerId` 回退已随着
  // 模式清理而消失；没有 orgId 的旧版事件将被删除并显示
  // 警告，以便它们显示在监控中。
  const resolved = await resolveOwnership(sub);
  if (!resolved) {
    logger.warn({ id: sub.id }, 'stripe-subscription-missing-owner');
    return;
  }
  const { ownerUserId, orgId } = resolved;

  const priceId = sub.items.data[0]?.price.id ?? '';
  const status = mapStatus(sub.status);

  const existing = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId: sub.id },
    select: { status: true, stripePriceId: true, cancelAtPeriodEnd: true },
  });

  await prisma.subscription.upsert({
    where: { stripeSubscriptionId: sub.id },
    create: {
      orgId,
      stripeSubscriptionId: sub.id,
      stripePriceId: priceId,
      status,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    },
    update: {
      stripePriceId: priceId,
      status,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    },
  });

  // 只有在某些内容发生重大变化（或全新）时才发出审计行。
  const changed =
    !existing ||
    existing.status !== status ||
    existing.stripePriceId !== priceId ||
    existing.cancelAtPeriodEnd !== sub.cancel_at_period_end;

  if (changed) {
    await recordAudit({
      actorId: null, // Stripe 是行为者
      orgId,
      action: 'billing.subscription_changed',
      target: ownerUserId,
      metadata: {
        sourceType,
        stripeSubscriptionId: sub.id,
        status,
        priceId,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
      },
    });

    // RFC 0003 PR-2 — 为订阅者提供的类型化一流 webhook 事件。
    // 我们根据来源选择类型化的名称：`created` 来自新的
    // 结账，`canceled` 来自 subscription.deleted Stripe 事件，
    // 其他一切都是 `updated`。省略 Stripe 标识符以保持
    // 跨我们的生产/暂存 Stripe 账户的可托管公共有效负载。
    const webhookType: WebhookEventType =
      sourceType === 'customer.subscription.deleted'
        ? 'subscription.canceled'
        : !existing
          ? 'subscription.created'
          : 'subscription.updated';
    await enqueueWebhook(orgId, webhookType, {
      status,
      priceId,
      currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    });
  }
}

interface Ownership {
  /* * OWNER 用户 — 仅用于审计元数据；未在 Subscription 上持久化。 */
  ownerUserId: string | null;
  orgId: string;
}

/**
 * 为 Stripe 订阅事件解析 `(orgId, ownerUserId)`。数据源：
 *   1. `metadata.orgId` —— 由我们的结账路由在每个新订阅上设置。
 *   2. 反向查找 `Organization.stripeCustomerId`。
 *
 * 两种来源均无法解析时返回 null —— 以 warning 级别上报，便于监控系统捕获。
 */
async function resolveOwnership(sub: Stripe.Subscription): Promise<Ownership | null> {
  const metaOrgId = typeof sub.metadata?.orgId === 'string' ? sub.metadata.orgId : null;
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

  if (metaOrgId) {
    const owner = await ownerOfOrg(metaOrgId);
    return { orgId: metaOrgId, ownerUserId: owner };
  }

  const orgByCustomer = await prisma.organization.findFirst({
    where: { stripeCustomerId: customerId },
    select: {
      id: true,
      memberships: {
        where: { role: OrgRole.OWNER },
        take: 1,
        select: { userId: true },
      },
    },
  });
  if (orgByCustomer) {
    return {
      orgId: orgByCustomer.id,
      ownerUserId: orgByCustomer.memberships[0]?.userId ?? null,
    };
  }

  return null;
}

async function ownerOfOrg(orgId: string): Promise<string | null> {
  const m = await prisma.membership.findFirst({
    where: { orgId, role: OrgRole.OWNER },
    select: { userId: true },
    orderBy: { joinedAt: 'asc' },
  });
  return m?.userId ?? null;
}

function mapStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case 'active':
      return 'ACTIVE';
    case 'trialing':
      return 'TRIALING';
    case 'past_due':
      return 'PAST_DUE';
    case 'canceled':
      return 'CANCELED';
    case 'incomplete':
      return 'INCOMPLETE';
    case 'incomplete_expired':
      return 'INCOMPLETE_EXPIRED';
    case 'unpaid':
      return 'UNPAID';
    default:
      return 'INCOMPLETE';
  }
}
