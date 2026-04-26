import 'server-only';

import { Region } from '@prisma/client';

import { env } from '@/env';
import { currentRegion } from '@/lib/region';

import { AlipayProvider } from './alipay';
import { StripeProvider } from './stripe';
import { WechatPayProvider } from './wechat';
import type { BillingProvider } from './types';

/**
 * Pick the active billing provider based on the deploy region. Today this
 * mirrors `currentRegion()` (RFC 0005); once we support per-user fallbacks
 * (e.g. Apple Pay users in CN region get Stripe instead) we'd accept a
 * `userId` and resolve here.
 *
 * NOTE — RFC 0005 §4.2 calls for `getBillingProvider()` to live in
 * `src/lib/region/providers.ts` next to the email + storage factories.
 * That module re-exports this function under that canonical name; the
 * implementation stays here so the existing Stripe / Alipay / WeChat
 * provider modules don't have to be reshuffled in the same PR.
 */
export function getProvider(): BillingProvider {
  switch (currentRegion()) {
    case Region.CN:
      // Default the CN region to Alipay; WeChat Pay is the alternative once
      // its provider is finished — toggle by exporting WECHAT_PAY_MCH_ID.
      return env.WECHAT_PAY_MCH_ID ? WechatPayProvider : AlipayProvider;
    case Region.EU:
    case Region.GLOBAL:
    default:
      return StripeProvider;
  }
}

export { type BillingProvider };
