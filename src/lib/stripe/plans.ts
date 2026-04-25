import { env } from '@/env';

export type PlanId = 'free' | 'pro' | 'team';

export interface Plan {
  id: PlanId;
  name: string;
  priceId: string | null;
}

export const plans: readonly Plan[] = [
  { id: 'free', name: 'Free', priceId: null },
  { id: 'pro', name: 'Pro', priceId: env.STRIPE_PRO_PRICE_ID ?? null },
  { id: 'team', name: 'Team', priceId: env.STRIPE_TEAM_PRICE_ID ?? null },
] as const;

export function getPlanByPriceId(priceId: string): Plan | undefined {
  return plans.find((plan) => plan.priceId === priceId);
}
