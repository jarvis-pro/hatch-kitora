import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import type Stripe from 'stripe';

import { env } from '@/env';
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

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await upsertSubscription(event.data.object);
        break;
      }
      case 'checkout.session.completed':
      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed': {
        logger.info({ type: event.type, id: event.id }, 'stripe-event');
        break;
      }
      default:
        break;
    }
    return NextResponse.json({ received: true });
  } catch (error) {
    logger.error({ err: error, type: event.type }, 'stripe-webhook-handler-failed');
    return NextResponse.json({ error: 'handler-failed' }, { status: 500 });
  }
}

async function upsertSubscription(sub: Stripe.Subscription) {
  const userId =
    (typeof sub.metadata?.userId === 'string' && sub.metadata.userId) ||
    (await resolveUserIdFromCustomer(sub.customer));
  if (!userId) {
    logger.warn({ id: sub.id }, 'stripe-subscription-missing-user');
    return;
  }

  const priceId = sub.items.data[0]?.price.id ?? '';
  const status = mapStatus(sub.status);

  await prisma.subscription.upsert({
    where: { stripeSubscriptionId: sub.id },
    create: {
      userId,
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
}

async function resolveUserIdFromCustomer(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer,
) {
  const customerId = typeof customer === 'string' ? customer : customer.id;
  const user = await prisma.user.findFirst({ where: { stripeCustomerId: customerId } });
  return user?.id;
}

function mapStatus(status: Stripe.Subscription.Status) {
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
