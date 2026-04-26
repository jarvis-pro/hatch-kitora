import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { OrgRole, type SubscriptionStatus } from '@prisma/client';

import { env } from '@/env';
import { recordAudit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { stripe } from '@/lib/stripe/client';

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

  // Idempotency: Stripe retries on 5xx / timeouts. Try to record the event id;
  // if it already exists, this throws and we return 200 to ack the duplicate.
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
    // On handler failure, drop the dedupe row so Stripe's retry can re-enter.
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
  // Subscription mode only: pull the subscription so we get full state.
  if (session.mode !== 'subscription' || !session.subscription) return;

  const subId =
    typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
  const sub = await stripe.subscriptions.retrieve(subId);
  await upsertSubscription(sub, 'checkout.session.completed');
}

async function upsertSubscription(sub: Stripe.Subscription, sourceType: string) {
  // Resolve owner. Source order: explicit `metadata.orgId` (PR-2 checkout
  // route always sets it) → metadata.userId → Organization.stripeCustomerId
  // → User.stripeCustomerId fallback (legacy customers from before PR-2).
  const resolved = await resolveOwnership(sub);
  if (!resolved) {
    logger.warn({ id: sub.id }, 'stripe-subscription-missing-owner');
    return;
  }
  const { userId, orgId } = resolved;

  const priceId = sub.items.data[0]?.price.id ?? '';
  const status = mapStatus(sub.status);

  const existing = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId: sub.id },
    select: { status: true, stripePriceId: true, cancelAtPeriodEnd: true },
  });

  // 双写 userId + orgId — PR-4 删 userId 时移除上半段。
  await prisma.subscription.upsert({
    where: { stripeSubscriptionId: sub.id },
    create: {
      userId,
      orgId,
      stripeSubscriptionId: sub.id,
      stripePriceId: priceId,
      status,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    },
    update: {
      // Heal stale rows backfilled with null orgId — set if currently empty.
      orgId,
      stripePriceId: priceId,
      status,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    },
  });

  // Only emit an audit row if something materially changed (or it's brand new).
  const changed =
    !existing ||
    existing.status !== status ||
    existing.stripePriceId !== priceId ||
    existing.cancelAtPeriodEnd !== sub.cancel_at_period_end;

  if (changed) {
    await recordAudit({
      actorId: null, // Stripe is the actor
      orgId,
      action: 'billing.subscription_changed',
      target: userId,
      metadata: {
        sourceType,
        stripeSubscriptionId: sub.id,
        status,
        priceId,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
      },
    });
  }
}

interface Ownership {
  userId: string;
  orgId: string;
}

/**
 * Resolve `(userId, orgId)` for a Stripe subscription event. Priority:
 *   1. `metadata.orgId` — set by our PR-2 checkout route, always present
 *      for new subscriptions.
 *   2. `metadata.userId` — legacy field, still emitted for backward
 *      compatibility.
 *   3. Reverse lookup `Organization.stripeCustomerId` (the canonical place
 *      after PR-2).
 *   4. Reverse lookup `User.stripeCustomerId` (rows that haven't been
 *      migrated yet).
 *
 * Returns null only when none of the four can resolve — that should never
 * happen in practice; we surface it as a webhook warning.
 */
async function resolveOwnership(sub: Stripe.Subscription): Promise<Ownership | null> {
  const metaOrgId = typeof sub.metadata?.orgId === 'string' ? sub.metadata.orgId : null;
  const metaUserId = typeof sub.metadata?.userId === 'string' ? sub.metadata.userId : null;
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

  if (metaOrgId) {
    const owner = await ownerOfOrg(metaOrgId);
    if (owner) return { orgId: metaOrgId, userId: owner };
  }

  if (metaUserId) {
    const orgId = await personalOrgIdOfUser(metaUserId);
    if (orgId) return { orgId, userId: metaUserId };
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
    const userId = orgByCustomer.memberships[0]?.userId;
    if (userId) return { orgId: orgByCustomer.id, userId };
  }

  const userByCustomer = await prisma.user.findFirst({
    where: { stripeCustomerId: customerId },
    select: { id: true },
  });
  if (userByCustomer) {
    const orgId = await personalOrgIdOfUser(userByCustomer.id);
    if (orgId) return { orgId, userId: userByCustomer.id };
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

async function personalOrgIdOfUser(userId: string): Promise<string | null> {
  const m = await prisma.membership.findFirst({
    where: { userId, role: OrgRole.OWNER },
    select: { orgId: true },
    orderBy: { joinedAt: 'asc' },
  });
  return m?.orgId ?? null;
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
