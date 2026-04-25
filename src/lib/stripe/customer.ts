import 'server-only';

import { prisma } from '@/lib/db';

import { stripe } from './client';

/** Returns the Stripe customer id for a user, creating one if needed. */
export async function getOrCreateStripeCustomerId(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }
  if (user.stripeCustomerId) {
    return user.stripeCustomerId;
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name ?? undefined,
    metadata: { userId },
  });

  await prisma.user.update({
    where: { id: userId },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}
