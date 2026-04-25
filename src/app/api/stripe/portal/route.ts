import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { env } from '@/env';
import { logger } from '@/lib/logger';
import { stripe } from '@/lib/stripe/client';
import { getOrCreateStripeCustomerId } from '@/lib/stripe/customer';

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const customerId = await getOrCreateStripeCustomerId(session.user.id);
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
