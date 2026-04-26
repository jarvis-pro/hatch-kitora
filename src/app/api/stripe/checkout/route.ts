import { NextResponse } from 'next/server';
import { z } from 'zod';

import { env } from '@/env';
import { requireActiveOrg } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { stripe } from '@/lib/stripe/client';
import { getOrCreateStripeCustomerId } from '@/lib/stripe/customer';

const schema = z.object({
  priceId: z.string().min(3),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

export async function POST(request: Request) {
  const me = await requireActiveOrg().catch(() => null);
  if (!me) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid-input' }, { status: 400 });
  }

  const customerId = await getOrCreateStripeCustomerId(me.orgId);
  const baseUrl = env.NEXT_PUBLIC_APP_URL;

  try {
    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: parsed.data.priceId, quantity: 1 }],
      success_url: parsed.data.successUrl ?? `${baseUrl}/dashboard?checkout=success`,
      cancel_url: parsed.data.cancelUrl ?? `${baseUrl}/pricing?checkout=canceled`,
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      client_reference_id: me.orgId,
      subscription_data: {
        // Both ids ride along — webhook resolveOwnership() prefers orgId
        // and falls back to userId for legacy events.
        metadata: { orgId: me.orgId, userId: me.userId },
      },
    });

    return NextResponse.json({ url: checkout.url });
  } catch (error) {
    logger.error({ err: error }, 'stripe-checkout-failed');
    return NextResponse.json({ error: 'checkout-failed' }, { status: 500 });
  }
}
