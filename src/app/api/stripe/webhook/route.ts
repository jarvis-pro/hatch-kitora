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
  // Resolve owner. After PR-4 the only sources are:
  //   1. `metadata.orgId` (always set by our checkout route)
  //   2. Reverse lookup `Organization.stripeCustomerId`
  // `metadata.userId` and `User.stripeCustomerId` fallbacks are gone with
  // the schema cleanup; legacy events without orgId are dropped with a
  // warning so they show up in monitoring.
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
      target: ownerUserId,
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
  /** OWNER user — only used for audit metadata; not persisted on Subscription. */
  ownerUserId: string | null;
  orgId: string;
}

/**
 * Resolve `(orgId, ownerUserId)` for a Stripe subscription event. Sources:
 *   1. `metadata.orgId` — set by our checkout route on every new sub.
 *   2. Reverse lookup `Organization.stripeCustomerId`.
 *
 * Returns null when neither resolves — surfaced as a warning so monitoring
 * picks it up.
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
