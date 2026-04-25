import 'server-only';

import { logger } from '@/lib/logger';

import type {
  BillingProvider,
  CheckoutInput,
  CheckoutResult,
  PortalInput,
  PortalResult,
} from './types';

/**
 * Alipay placeholder provider — wire up `alipay-sdk` (or the official Node
 * SDK once it stabilises) when going live in mainland China. We keep the
 * shape complete so call sites compile against the abstraction.
 */
export const AlipayProvider: BillingProvider = {
  id: 'alipay',

  async createCheckoutSession(input: CheckoutInput): Promise<CheckoutResult> {
    logger.warn({ input }, 'alipay-checkout-not-implemented');
    throw new Error('alipay-not-implemented');
  },

  async createPortalSession(input: PortalInput): Promise<PortalResult> {
    logger.warn({ input }, 'alipay-portal-not-implemented');
    throw new Error('alipay-not-implemented');
  },
};
