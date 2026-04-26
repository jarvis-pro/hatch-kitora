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
    orgId,
    ownerUserId,
    priceId,
    successUrl,
    cancelUrl,
  }: CheckoutInput): Promise<CheckoutResult> {
    const customerId = await getOrCreateStripeCustomerId(orgId);
    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      client_reference_id: orgId,
      subscription_data: {
        metadata: { orgId, ownerUserId: ownerUserId ?? '' },
      },
    });
    if (!checkout.url) throw new Error('stripe-checkout-no-url');
    return { url: checkout.url };
  },

  async createPortalSession({ orgId, returnUrl }: PortalInput): Promise<PortalResult> {
    const customerId = await getOrCreateStripeCustomerId(orgId);
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return { url: portal.url };
  },
};
