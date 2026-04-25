import 'server-only';

import Stripe from 'stripe';

import { env } from '@/env';

if (!env.STRIPE_SECRET_KEY && env.NODE_ENV === 'production') {
  throw new Error('STRIPE_SECRET_KEY is required in production.');
}

export const stripe = new Stripe(env.STRIPE_SECRET_KEY ?? 'sk_test_placeholder', {
  // Pin to the version supported by the installed `stripe` SDK.
  apiVersion: '2025-02-24.acacia',
  typescript: true,
  appInfo: {
    name: 'Kitora',
    version: '0.1.0',
  },
});
