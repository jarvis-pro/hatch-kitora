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
 * WeChat Pay placeholder. Replace with `wechatpay-node-v3` (or your gateway
 * of choice) and enable QR-code / JSAPI flows once 备案 is approved.
 */
export const WechatPayProvider: BillingProvider = {
  id: 'wechat',

  async createCheckoutSession(input: CheckoutInput): Promise<CheckoutResult> {
    logger.warn({ input }, 'wechat-checkout-not-implemented');
    throw new Error('wechat-not-implemented');
  },

  async createPortalSession(input: PortalInput): Promise<PortalResult> {
    logger.warn({ input }, 'wechat-portal-not-implemented');
    throw new Error('wechat-not-implemented');
  },
};
