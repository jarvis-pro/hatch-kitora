import 'server-only';

import Stripe from 'stripe';

import { env } from '@/env';

/**
 * Stripe is an optional integration. When `STRIPE_SECRET_KEY` is not set the
 * client is still instantiated with a non-functional placeholder so that
 * importing this module never crashes (`next build` collects page data by
 * importing every route handler). Any actual API call without a real key will
 * fail at request time with a clear Stripe error — that's the right place to
 * surface "billing is not configured".
 */
export const stripe = new Stripe(env.STRIPE_SECRET_KEY ?? 'sk_test_unconfigured', {
  // Pin to the version supported by the installed `stripe` SDK.
  apiVersion: '2025-02-24.acacia',
  typescript: true,
  appInfo: {
    name: 'Kitora',
    version: '0.1.0',
  },
});

/** Convenience flag for callers that want to short-circuit before an API call. */
export const isStripeConfigured = Boolean(env.STRIPE_SECRET_KEY);
