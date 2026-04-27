import 'server-only';

import Stripe from 'stripe';

import { env } from '@/env';

/**
 * Stripe 是一个可选集成。当未设置 `STRIPE_SECRET_KEY` 时，
 * 客户端仍然用非功能占位符实例化，以便导入此模块
 * 永不崩溃（`next build` 通过导入每个路由处理程序收集页面数据）。
 * 任何不带真密钥的实际 API 调用将在请求时失败
 * 并显示清晰的 Stripe 错误 — 这是浮出"未配置计费"的正确位置。
 */
export const stripe = new Stripe(env.STRIPE_SECRET_KEY ?? 'sk_test_unconfigured', {
  // 固定到已安装 `stripe` SDK 支持的版本。
  apiVersion: '2025-02-24.acacia',
  typescript: true,
  appInfo: {
    name: 'Kitora',
    version: '0.1.0',
  },
});

/** 便利标志对想在 API 调用前短路的调用者。 */
export const isStripeConfigured = Boolean(env.STRIPE_SECRET_KEY);
