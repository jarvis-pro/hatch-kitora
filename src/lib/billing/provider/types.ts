/**
 * Region-agnostic billing provider contract.
 *
 * One concrete implementation per payment rail: StripeProvider for global
 * markets (cards / Apple Pay / SEPA / etc.), AlipayProvider and
 * WechatPayProvider for mainland China. Pick one at boot via `getProvider()`
 * which reads `currentRegion()` (RFC 0005).
 */
export interface CheckoutInput {
  /** Active organization the subscription belongs to (RFC-0001 multi-tenant). */
  orgId: string;
  /** OWNER user — used only for Stripe customer cosmetics / portal contact. */
  ownerUserId?: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutResult {
  /** URL the browser should be sent to. */
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
  /** Hosted-checkout URL builder. Throws on configuration errors. */
  createCheckoutSession(input: CheckoutInput): Promise<CheckoutResult>;
  /** Self-service customer portal — manage payment methods, cancel, etc. */
  createPortalSession(input: PortalInput): Promise<PortalResult>;
}
