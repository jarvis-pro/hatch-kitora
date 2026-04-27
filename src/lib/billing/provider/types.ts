/**
 * 区域无关的账单提供商契约。
 *
 * 每个支付轨道一个具体实现：全球市场的 StripeProvider
 * （卡 / Apple Pay / SEPA / 等），以及中国大陆的
 * AlipayProvider 和 WechatPayProvider。通过 `getProvider()`
 * 在启动时选择一个，该函数读取 `currentRegion()`（RFC 0005）。
 */
export interface CheckoutInput {
  /** 订阅所属的活跃组织（RFC-0001 多租户）。 */
  orgId: string;
  /** OWNER 用户 — 仅用于 Stripe 客户化妆品 / 门户联系。 */
  ownerUserId?: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutResult {
  /** 应将浏览器发送到的 URL。 */
  url: string;
}

export interface PortalInput {
  orgId: string;
  returnUrl: string;
}

export interface PortalResult {
  url: string;
}

export interface BillingProvider {
  readonly id: 'stripe' | 'alipay' | 'wechat';
  /** 托管结账 URL 构建器。在配置错误时抛出。 */
  createCheckoutSession(input: CheckoutInput): Promise<CheckoutResult>;
  /** 自助客户门户 — 管理支付方式、取消等。 */
  createPortalSession(input: PortalInput): Promise<PortalResult>;
}
