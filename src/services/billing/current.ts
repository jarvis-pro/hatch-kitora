import 'server-only';

import type { Subscription } from '@prisma/client';

import { prisma } from '@/lib/db';
import { getFreePlan, getPlanByPriceId, type Plan } from '@/lib/stripe/plans';

export interface CurrentBilling {
  /** 已解决的计划 — 如果没有活跃订阅，则回落到免费计划。 */
  plan: Plan;
  /** 活跃订阅行，或如果用户在免费版上则为 `null`。 */
  subscription: Pick<
    Subscription,
    'id' | 'status' | 'stripePriceId' | 'currentPeriodEnd' | 'cancelAtPeriodEnd'
  > | null;
}

const LIVE_STATUSES = ['ACTIVE', 'TRIALING', 'PAST_DUE'] as const;

/**
 * 解析组织的当前计划 + 订阅。选择最新的"活跃"订阅；
 * 如果没有，返回免费计划。
 *
 * PR-2：切换到组织范围的查找。订阅现在在双写窗口期间使用 orgId
 * 创建；早于回填的行也设置了 orgId（请参见 scripts/migrate-personal-orgs.ts）。
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
