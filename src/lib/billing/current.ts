import 'server-only';

import type { Subscription } from '@prisma/client';

import { prisma } from '@/lib/db';
import { getFreePlan, getPlanByPriceId, type Plan } from '@/lib/stripe/plans';

export interface CurrentBilling {
  /** Resolved plan — falls back to the Free plan if no live subscription. */
  plan: Plan;
  /** Live subscription row, or `null` if the user is on Free. */
  subscription: Pick<
    Subscription,
    'id' | 'status' | 'stripePriceId' | 'currentPeriodEnd' | 'cancelAtPeriodEnd'
  > | null;
}

const LIVE_STATUSES = ['ACTIVE', 'TRIALING', 'PAST_DUE'] as const;

/**
 * Resolve the org's current plan + subscription. Picks the most recent
 * "live" subscription; if there is none, returns the Free plan.
 *
 * PR-2: switched to org-scoped lookup. Subscriptions are now created with
 * orgId during the dual-write window; rows older than the backfill have
 * orgId set as well (see scripts/migrate-personal-orgs.ts).
 */
export async function getCurrentBilling(orgId: string): Promise<CurrentBilling> {
  const subscription = await prisma.subscription.findFirst({
    where: { orgId, status: { in: [...LIVE_STATUSES] } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      stripePriceId: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
    },
  });

  if (!subscription) {
    return { plan: getFreePlan(), subscription: null };
  }

  const plan = getPlanByPriceId(subscription.stripePriceId) ?? getFreePlan();
  return { plan, subscription };
}
