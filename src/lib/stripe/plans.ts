import { env } from '@/env';

export type PlanId = 'free' | 'pro' | 'team';

export interface Plan {
  id: PlanId;
  name: string;
  priceId: string | null;
  /** Display amount in **cents**, USD. Source of truth is Stripe — this is
   *  used only for UI cards / approximate MRR. */
  amountCents: number;
  interval: 'month' | 'year' | null;
}

export const plans: readonly Plan[] = [
  { id: 'free', name: 'Free', priceId: null, amountCents: 0, interval: null },
  {
    id: 'pro',
    name: 'Pro',
    priceId: env.STRIPE_PRO_PRICE_ID ?? null,
    amountCents: 1900,
    interval: 'month',
  },
  {
    id: 'team',
    name: 'Team',
    priceId: env.STRIPE_TEAM_PRICE_ID ?? null,
    amountCents: 4900,
    interval: 'month',
  },
] as const;

export function getPlanByPriceId(priceId: string): Plan | undefined {
  return plans.find((plan) => plan.priceId === priceId);
}

export function getFreePlan(): Plan {
  // Always defined — see `plans` above.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return plans.find((p) => p.id === 'free')!;
}
