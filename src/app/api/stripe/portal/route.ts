import { NextResponse } from 'next/server';

import { env } from '@/env';
import { requireActiveOrg } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { stripe } from '@/lib/stripe/client';
import { getOrCreateStripeCustomerId } from '@/lib/stripe/customer';

export async function POST() {
  const me = await requireActiveOrg().catch(() => null);
  if (!me) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const customerId = await getOrCreateStripeCustomerId(me.orgId);
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${env.NEXT_PUBLIC_APP_URL}/settings`,
    });

    return NextResponse.json({ url: portal.url });
  } catch (error) {
    logger.error({ err: error }, 'stripe-portal-failed');
    return NextResponse.json({ error: 'portal-failed' }, { status: 500 });
  }
}
