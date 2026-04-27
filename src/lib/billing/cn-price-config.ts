// RFC 0006 PR-3 — Stripe 价格 ID → 中国价格（CNY）映射。
//
// Stripe 结账从 Stripe API 查询规范价格；CN 提供商没有这样的优势 —
// 支付宝和微信支付要求商户直接传递 `total_amount`。此模块是
// "v0.6 SaaS 目录映射到人民币"被编码的唯一位置。
//
// 保持映射最小化：每个已知的 Stripe 价格 ID 获得一行。
// 值来自环境变量（以便运维可以按月调整而无需代码推送）
// 并内置理性的回落默认值。

import 'server-only';

import { env } from '@/env';

export interface CnPrice {
  /** CNY（元）中的金额 — 两位小数。支付宝接受小数；
   * 微信取分，所以调用者乘以 100 + 舍入。 */
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
  // 未知的 priceId — 大声失败，以便配置错误的客户端不会
  // 意外充电默认价格。
  throw new Error(`unknown-cn-price:${stripePriceId}`);
}

function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}
