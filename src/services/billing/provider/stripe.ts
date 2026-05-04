import 'server-only';

import { stripe } from '@/lib/stripe/client';
import { getOrCreateStripeCustomerId } from '@/lib/stripe/customer';

import type {
  BillingProvider,
  CheckoutInput,
  CheckoutResult,
  PortalInput,
  PortalResult,
} from './types';

/**
 * Stripe 计费提供方实现。
 *
 * 实现 `BillingProvider` 接口，将我们应用层的"创建结算页/客户门户"
 * 概念映射到 Stripe Checkout / Billing Portal 的具体调用。
 *
 * - 订阅模式（`mode: 'subscription'`），即一次结账绑定一个周期性订阅。
 * - 启用自动税费计算与促销码输入框。
 * - 通过 `client_reference_id` 与 `subscription_data.metadata`
 *   把 Stripe 端记录与我们内部的 `orgId` / `ownerUserId` 关联起来，
 *   便于 webhook 回调时定位到具体组织。
 */
export const StripeProvider: BillingProvider = {
  id: 'stripe',

  /**
   * 创建一次 Stripe Checkout 结算会话。
   *
   * @param input 结算入参，包含组织 ID、发起人 ID、价格 ID 与回跳 URL 等。
   * @returns 返回一个携带 Checkout 跳转 URL 的对象。
   * @throws 当 Stripe 未返回 `url` 字段时抛出 `stripe-checkout-no-url`。
   */
  async createCheckoutSession({
    orgId,
    ownerUserId,
    priceId,
    successUrl,
    cancelUrl,
  }: CheckoutInput): Promise<CheckoutResult> {
    // 复用或创建该组织对应的 Stripe Customer，避免重复建客户
    const customerId = await getOrCreateStripeCustomerId(orgId);
    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      // 客户引用 ID 会出现在 webhook 事件中，便于反查组织
      client_reference_id: orgId,
      subscription_data: {
        metadata: { orgId, ownerUserId: ownerUserId ?? '' },
      },
    });
    if (!checkout.url) throw new Error('stripe-checkout-no-url');
    return { url: checkout.url };
  },

  /**
   * 创建一次 Stripe 计费门户会话（管理付款方式、查看发票、取消订阅等）。
   *
   * @param input 入参，包含组织 ID 与门户关闭后回跳的 URL。
   * @returns 返回携带门户跳转 URL 的对象。
   */
  async createPortalSession({ orgId, returnUrl }: PortalInput): Promise<PortalResult> {
    const customerId = await getOrCreateStripeCustomerId(orgId);
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return { url: portal.url };
  },
};
