// RFC 0006 PR-3 — Stripe price ID → CN price (CNY) mapping.
//
// Stripe checkout queries the Stripe API for the canonical price; CN
// providers don't have that luxury — Alipay and WeChat Pay ask the
// merchant to pass `total_amount` directly. This module is the single
// place where "the v0.6 SaaS catalogue maps to RMB" is encoded.
//
// Keep the mapping minimal: each known Stripe price ID gets one row.
// Values come from env (so ops can tweak monthly without a code push)
// with sane fallback defaults baked in.

import 'server-only';

import { env } from '@/env';

export interface CnPrice {
  /** Amount in CNY (yuan) — two decimal places. Alipay accepts decimals;
   * WeChat takes fen, so callers multiply by 100 + round. */
  amount: number;
  subject: string;
  description: string;
}

const DEFAULT_PRO_AMOUNT = 99;
const DEFAULT_TEAM_AMOUNT = 199;

export function resolveCnPrice(stripePriceId: string): CnPrice {
  if (env.STRIPE_PRO_PRICE_ID && stripePriceId === env.STRIPE_PRO_PRICE_ID) {
    return {
      amount: parseAmount(process.env.CN_PRO_PRICE_CNY) ?? DEFAULT_PRO_AMOUNT,
      subject: 'Kitora Pro · 月度订阅',
      description: 'Kitora Pro 计划，按月续费，可随时取消。',
    };
  }
  if (env.STRIPE_TEAM_PRICE_ID && stripePriceId === env.STRIPE_TEAM_PRICE_ID) {
    return {
      amount: parseAmount(process.env.CN_TEAM_PRICE_CNY) ?? DEFAULT_TEAM_AMOUNT,
      subject: 'Kitora Team · 月度订阅',
      description: 'Kitora Team 计划（最多 5 个席位），按月续费，可随时取消。',
    };
  }
  // Unknown priceId — fail loudly so a misconfigured client doesn't
  // accidentally charge a default price.
  throw new Error(`unknown-cn-price:${stripePriceId}`);
}

function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}
