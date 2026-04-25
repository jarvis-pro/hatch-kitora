import 'server-only';

import { prisma } from '@/lib/db';

export interface AdminMetrics {
  totalUsers: number;
  newUsersLast7d: number;
  activeSubscriptions: number;
  /** Approximate MRR in USD cents — sum of `Pro` / `Team` plan prices.
   *  Real MRR should come from Stripe; this is a rough indicator only. */
  approxMrrCents: number;
}

const MRR_BY_PRICE_ID: Record<string, number> = {};
if (process.env.STRIPE_PRO_PRICE_ID) MRR_BY_PRICE_ID[process.env.STRIPE_PRO_PRICE_ID] = 1900;
if (process.env.STRIPE_TEAM_PRICE_ID) MRR_BY_PRICE_ID[process.env.STRIPE_TEAM_PRICE_ID] = 4900;

export async function getAdminMetrics(): Promise<AdminMetrics> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [totalUsers, newUsersLast7d, activeSubs] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.subscription.findMany({
      where: { status: { in: ['ACTIVE', 'TRIALING'] } },
      select: { stripePriceId: true },
    }),
  ]);

  const approxMrrCents = activeSubs.reduce(
    (sum, s) => sum + (MRR_BY_PRICE_ID[s.stripePriceId] ?? 0),
    0,
  );

  return {
    totalUsers,
    newUsersLast7d,
    activeSubscriptions: activeSubs.length,
    approxMrrCents,
  };
}
