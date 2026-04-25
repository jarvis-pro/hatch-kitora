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

export const StripeProvider: BillingProvider = {
  id: 'stripe',

  async createCheckoutSession({
    userId,
    priceId,
    successUrl,
    cancelUrl,
  }: CheckoutInput): Promise<CheckoutResult> {
    const customerId = await getOrCreateStripeCustomerId(userId);
    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      client_reference_id: userId,
      subscription_data: { metadata: { userId } },
    });
    if (!checkout.url) throw new Error('stripe-checkout-no-url');
    return { url: checkout.url };
  },

  async createPortalSession({ userId, returnUrl }: PortalInput): Promise<PortalResult> {
    const customerId = await getOrCreateStripeCustomerId(userId);
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return { url: portal.url };
  },
};
