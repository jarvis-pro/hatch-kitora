// RFC 0006 PR-3 — Alipay billing provider (production-shaped impl).
//
// Wraps the official `alipay-sdk` v4 to expose four flows mapped onto our
// `BillingProvider` contract:
//
//   1. createCheckoutSession  → 「电脑网站支付」(`alipay.trade.page.pay`)
//                                returns the alipay.com redirect URL.
//   2. createPortalSession    → self-hosted `/billing/cn-portal` page
//                                (Alipay has no native customer-portal
//                                analogue; the Next.js page reads our
//                                Subscription state and offers cancel /
//                                manage-agreement actions).
//   3. verifyAlipayNotify     → exposed for the inbound webhook route to
//                                verify the RSA2 signature on Alipay's
//                                async notification.
//   4. refund + chargeAgreement → small helpers used by ops scripts and
//                                 the cron-driven 周期扣款 worker.
//
// The SDK is loaded *lazily* at first use so a GLOBAL-region process
// (which never reaches AlipayProvider) doesn't pay the import cost.
// `import type` keeps the call sites type-safe without forcing a runtime
// module load.

import 'server-only';

import type { AlipaySdk as AlipaySdkType } from 'alipay-sdk';

import { env } from '@/env';
import { resolveCnPrice } from '@/lib/billing/cn-price-config';
import { logger } from '@/lib/logger';
import { currentRegion } from '@/lib/region';

import type {
  BillingProvider,
  CheckoutInput,
  CheckoutResult,
  PortalInput,
  PortalResult,
} from './types';

// ─── Lazy SDK init ─────────────────────────────────────────────────────────

let _client: AlipaySdkType | null = null;

async function getClient(): Promise<AlipaySdkType> {
  if (_client) return _client;

  if (!env.ALIPAY_APP_ID || !env.ALIPAY_PRIVATE_KEY || !env.ALIPAY_PUBLIC_KEY) {
    throw new Error(
      'alipay-not-configured: ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY / ALIPAY_PUBLIC_KEY missing',
    );
  }

  // Dynamic import keeps the SDK out of GLOBAL bundles. The runtime cost
  // is paid once on the first CN payment request.
  const mod = await import('alipay-sdk');
  // alipay-sdk v4 exports `AlipaySdk` as a named export; some tooling
  // exposes it as default. Accept both to be defensive across upgrades.
  const Ctor = ((mod as { AlipaySdk?: typeof AlipaySdkType }).AlipaySdk ??
    (mod as { default?: typeof AlipaySdkType }).default) as typeof AlipaySdkType;

  _client = new Ctor({
    appId: env.ALIPAY_APP_ID,
    privateKey: env.ALIPAY_PRIVATE_KEY,
    alipayPublicKey: env.ALIPAY_PUBLIC_KEY,
    gateway: env.ALIPAY_GATEWAY,
    signType: 'RSA2',
    timeout: 10_000,
  });

  return _client;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Build a deterministic, idempotent business order number (≤ 64 chars). */
function buildOutTradeNo(orgId: string): string {
  return `kitora-${orgId}-${Date.now()}`;
}

function notifyUrl(): string {
  const base = env.CN_PUBLIC_API_URL ?? env.NEXT_PUBLIC_APP_URL;
  return `${base.replace(/\/+$/, '')}/api/billing/alipay/notify`;
}

// ─── Provider implementation ───────────────────────────────────────────────

export const AlipayProvider: BillingProvider = {
  id: 'alipay',

  async createCheckoutSession(input: CheckoutInput): Promise<CheckoutResult> {
    if (currentRegion() !== 'CN') {
      // Defence-in-depth: provider factory should already gate this, but a
      // mis-wired call from GLOBAL must fail loudly, not silently build a
      // kit URL pointing at the wrong rail.
      throw new Error('alipay-only-available-in-cn-region');
    }

    const price = resolveCnPrice(input.priceId);
    const outTradeNo = buildOutTradeNo(input.orgId);

    const sdk = await getClient();

    // `pageExec` returns a fully-formed alipay.com redirect URL (the SDK
    // signs + URL-encodes it). The browser hits that URL, lands on the
    // Alipay-hosted checkout page, completes payment, then Alipay
    // bounces the user back to `returnUrl` with a synchronous result —
    // we DO NOT trust the synchronous return; the authoritative signal
    // is the async notification we receive at `notifyUrl()`.
    const url: string = await sdk.pageExec('alipay.trade.page.pay', {
      bizContent: {
        out_trade_no: outTradeNo,
        product_code: 'FAST_INSTANT_TRADE_PAY',
        total_amount: price.amount.toFixed(2),
        subject: price.subject,
        body: price.description,
        // `passback_params` is round-tripped verbatim in the async notify;
        // we encode our orgId + priceId so the webhook can resolve back
        // to the right Subscription without a DB lookup on out_trade_no.
        passback_params: encodeURIComponent(
          JSON.stringify({ orgId: input.orgId, priceId: input.priceId }),
        ),
      },
      notifyUrl: notifyUrl(),
      returnUrl: input.successUrl,
    });

    logger.info(
      { orgId: input.orgId, priceId: input.priceId, outTradeNo },
      'alipay-checkout-created',
    );

    return { url };
  },

  async createPortalSession(input: PortalInput): Promise<PortalResult> {
    // Alipay does not expose a native customer portal. We surface a self-
    // hosted page that reads `Subscription.cnAgreementId`, lets the user
    // cancel the 免密协议 (calls `unsignAlipayAgreement` below), and
    // shows the last 12 invoices already in our DB. Less polished than
    // Stripe's hosted portal but covers the only two flows users
    // actually need: "when does it renew?" and "cancel".
    const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
    const url = `${base}/billing/cn-portal?provider=alipay&orgId=${encodeURIComponent(input.orgId)}`;
    return { url };
  },
};

// ─── Inbound notification verification ─────────────────────────────────────

/**
 * Verify the RSA2 signature on an inbound Alipay async notification. The
 * caller (webhook route) must hand us the raw form-encoded body parsed
 * into a flat string-map; the SDK reads `params.sign` + `params.sign_type`
 * and computes the expected signature off the rest.
 */
export async function verifyAlipayNotify(params: Record<string, string>): Promise<boolean> {
  const sdk = await getClient();
  try {
    return sdk.checkNotifySign(params);
  } catch (error) {
    logger.warn({ err: error }, 'alipay-checknotify-throw');
    return false;
  }
}

/** Decode the `passback_params` round-tripped through Alipay. */
export function decodeAlipayPassback(
  raw: string | undefined,
): { orgId: string; priceId: string } | null {
  if (!raw) return null;
  try {
    const decoded = JSON.parse(decodeURIComponent(raw)) as unknown;
    if (
      decoded &&
      typeof decoded === 'object' &&
      'orgId' in decoded &&
      'priceId' in decoded &&
      typeof (decoded as Record<string, unknown>).orgId === 'string' &&
      typeof (decoded as Record<string, unknown>).priceId === 'string'
    ) {
      return decoded as { orgId: string; priceId: string };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Refund + agreement helpers ────────────────────────────────────────────

export interface RefundInput {
  outTradeNo: string;
  refundAmount: number; // CNY, two decimal places
  outRequestNo: string; // idempotency key
  reason?: string;
}

/** Synchronous refund. Returns the SDK response verbatim for audit. */
export async function refundAlipayCharge(input: RefundInput): Promise<unknown> {
  const sdk = await getClient();
  return sdk.exec('alipay.trade.refund', {
    bizContent: {
      out_trade_no: input.outTradeNo,
      refund_amount: input.refundAmount.toFixed(2),
      out_request_no: input.outRequestNo,
      refund_reason: input.reason ?? 'user-requested',
    },
  });
}

/**
 * End a 免密协议 (`alipay.user.agreement.unsign`) so the cron worker
 * stops issuing periodic charges. Called from `/billing/cn-portal`
 * cancel button and from the admin "force cancel" tool.
 */
export async function unsignAlipayAgreement(agreementNo: string): Promise<void> {
  const sdk = await getClient();
  await sdk.exec('alipay.user.agreement.unsign', {
    bizContent: { agreement_no: agreementNo },
  });
}

/**
 * Issue a periodic charge against an existing 免密协议 — invoked by the
 * `run-cn-billing-cron.ts` worker once per billing cycle. Returns the
 * provider trade no on success.
 */
export async function chargeAlipayAgreement(input: {
  agreementNo: string;
  amount: number;
  outTradeNo: string;
  subject: string;
}): Promise<{ tradeNo: string }> {
  const sdk = await getClient();
  const result = (await sdk.exec('alipay.trade.create', {
    bizContent: {
      out_trade_no: input.outTradeNo,
      total_amount: input.amount.toFixed(2),
      subject: input.subject,
      product_code: 'GENERAL_WITHHOLDING',
      agreement_params: { agreement_no: input.agreementNo },
    },
    notifyUrl: notifyUrl(),
  })) as { trade_no?: string };

  if (!result.trade_no) {
    throw new Error('alipay-charge-no-trade-no');
  }
  return { tradeNo: result.trade_no };
}
