import 'server-only';

import { env } from '@/env';

import { AlipayProvider } from './alipay';
import { StripeProvider } from './stripe';
import { WechatPayProvider } from './wechat';
import type { BillingProvider } from './types';

/**
 * Pick the active billing provider based on the deploy region. Today this
 * mirrors `env.REGION`; once we support per-user fallbacks (e.g. Apple Pay
 * users in CN region get Stripe instead) we'd accept a `userId` and resolve
 * here.
 */
export function getProvider(): BillingProvider {
  switch (env.REGION) {
    case 'cn':
      // Default the CN region to Alipay; WeChat Pay is the alternative once
      // its provider is finished — toggle by exporting WECHAT_PAY_MCH_ID.
      return env.WECHAT_PAY_MCH_ID ? WechatPayProvider : AlipayProvider;
    case 'global':
    default:
      return StripeProvider;
  }
}

export { type BillingProvider };
