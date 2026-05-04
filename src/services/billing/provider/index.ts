import 'server-only';

import { Region } from '@prisma/client';

import { env } from '@/env';
import { currentRegion } from '@/lib/region';

import { AlipayProvider } from './alipay';
import { StripeProvider } from './stripe';
import { WechatPayProvider } from './wechat';
import type { BillingProvider } from './types';

/**
 * 根据部署区域选择活跃账单提供商。今天这反映
 * `currentRegion()`（RFC 0005）；一旦我们支持按用户回落
 * （例如 CN 区域的 Apple Pay 用户改用 Stripe）
 * 我们会接受一个 `userId` 并在此处解析。
 *
 * 注意 — RFC 0005 §4.2 要求 `getBillingProvider()` 在
 * `src/lib/region/providers.ts` 中位于电子邮件 + 存储工厂旁边。
 * 该模块在该规范名称下重新导出此函数；实现保持在这里，
 * 以便现有的 Stripe / Alipay / WeChat 提供商模块
 * 不必在同一 PR 中重新改组。
 */
export function getProvider(): BillingProvider {
  switch (currentRegion()) {
    case Region.CN:
      // CN 区域默认为支付宝；微信支付是完成提供商后的替代方案 —
      // 通过导出 WECHAT_PAY_MCH_ID 进行切换。
      return env.WECHAT_PAY_MCH_ID ? WechatPayProvider : AlipayProvider;
    case Region.EU:
    case Region.GLOBAL:
    default:
      return StripeProvider;
  }
}

export { type BillingProvider };
