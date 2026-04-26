// RFC 0006 PR-3 — WeChat Pay billing provider (Native pay, APIv3).
//
// Wraps the community-maintained `wechatpay-node-v3` SDK. v1 supports
// only Native pay (二维码扫码) — JSAPI / 小程序 / H5 flows defer to a
// follow-up RFC. From the BillingProvider contract's POV:
//
//   * createCheckoutSession returns a `code_url` (a `weixin://` URI). The
//     caller is the front-end QR-code component, which renders the URI
//     into a QR image inside a modal. We do NOT redirect the browser to
//     `code_url` — that's not a navigable URL.
//   * createPortalSession returns a self-hosted `/billing/cn-portal` URL,
//     symmetric to the Alipay case (no native portal exists).
//
// Inbound notifications carry an AES-GCM ciphertext under
// `resource.ciphertext`; `decryptWechatNotify` exposes the decryption
// helper for the route handler.

import 'server-only';

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

// ─── SDK shape (minimal local view) ────────────────────────────────────────
//
// We model only the surface we actually invoke. The community SDK has
// historical churn around constructor argument names; the local interface
// keeps the rest of this file insulated from those drifts.

interface WxPayClientLike {
  transactions_native(input: {
    appid: string;
    mchid: string;
    description: string;
    out_trade_no: string;
    notify_url: string;
    amount: { total: number; currency: 'CNY' };
    attach?: string;
  }): Promise<{ code_url?: string; data?: { code_url?: string } }>;

  decipher_gcm<T>(ciphertext: string, associated_data: string, nonce: string, apiv3_key: string): T;

  refund(input: {
    out_refund_no: string;
    out_trade_no?: string;
    transaction_id?: string;
    amount: { refund: number; total: number; currency: 'CNY' };
    reason?: string;
    notify_url?: string;
  }): Promise<unknown>;
}

// ─── Lazy SDK init ─────────────────────────────────────────────────────────

let _client: WxPayClientLike | null = null;

async function getClient(): Promise<WxPayClientLike> {
  if (_client) return _client;

  const required = [
    env.WECHAT_PAY_MCH_ID,
    env.WECHAT_PAY_APIV3_KEY,
    env.WECHAT_PAY_MERCHANT_PRIVATE_KEY,
    env.WECHAT_PAY_MERCHANT_SERIAL_NO,
    env.WECHAT_PAY_APP_ID,
  ];
  if (required.some((v) => !v)) {
    throw new Error(
      'wechat-pay-not-configured: WECHAT_PAY_{MCH_ID,APIV3_KEY,MERCHANT_PRIVATE_KEY,MERCHANT_SERIAL_NO,APP_ID} required',
    );
  }

  const mod = await import('wechatpay-node-v3');
  const Ctor = ((mod as { default?: new (cfg: unknown) => WxPayClientLike }).default ??
    (mod as unknown as { WxPay?: new (cfg: unknown) => WxPayClientLike }).WxPay) as new (
    cfg: unknown,
  ) => WxPayClientLike;

  _client = new Ctor({
    appid: env.WECHAT_PAY_APP_ID,
    mchid: env.WECHAT_PAY_MCH_ID,
    publicKey: Buffer.from('', 'utf8'), // platform certificate auto-fetched by SDK
    privateKey: Buffer.from(env.WECHAT_PAY_MERCHANT_PRIVATE_KEY ?? '', 'utf8'),
    serial_no: env.WECHAT_PAY_MERCHANT_SERIAL_NO,
    key: env.WECHAT_PAY_APIV3_KEY,
  });

  return _client;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildOutTradeNo(orgId: string): string {
  // 32 char limit on WeChat (stricter than Alipay's 64). 11 + cuid (25) is
  // already too long, so we use the cuid suffix only.
  const suffix = orgId.slice(-12);
  return `kt-${suffix}-${Date.now()}`;
}

function notifyUrl(): string {
  const base = env.CN_PUBLIC_API_URL ?? env.NEXT_PUBLIC_APP_URL;
  return `${base.replace(/\/+$/, '')}/api/billing/wechat/notify`;
}

// ─── Provider implementation ───────────────────────────────────────────────

export const WechatPayProvider: BillingProvider = {
  id: 'wechat',

  async createCheckoutSession(input: CheckoutInput): Promise<CheckoutResult> {
    if (currentRegion() !== 'CN') {
      throw new Error('wechat-only-available-in-cn-region');
    }

    const price = resolveCnPrice(input.priceId);
    const outTradeNo = buildOutTradeNo(input.orgId);

    const sdk = await getClient();

    const result = await sdk.transactions_native({
      appid: env.WECHAT_PAY_APP_ID!,
      mchid: env.WECHAT_PAY_MCH_ID!,
      description: price.subject,
      out_trade_no: outTradeNo,
      notify_url: notifyUrl(),
      amount: {
        // WeChat amounts are in fen (1/100 CNY). Multiply by 100 + round
        // to avoid floating point drift on prices like 99.99.
        total: Math.round(price.amount * 100),
        currency: 'CNY',
      },
      attach: JSON.stringify({ orgId: input.orgId, priceId: input.priceId }),
    });

    // Different SDK versions return `code_url` flat or nested under
    // `data.code_url`. Accept both.
    const codeUrl = result.code_url ?? result.data?.code_url;
    if (!codeUrl) {
      logger.error({ result }, 'wechat-native-no-code-url');
      throw new Error('wechat-native-no-code-url');
    }

    logger.info(
      { orgId: input.orgId, priceId: input.priceId, outTradeNo },
      'wechat-checkout-created',
    );

    // The contract is `{ url: string }` — for WeChat Native, this URL is
    // a `weixin://` URI to be rendered as a QR code on the front-end.
    // Callers in CN-region that hit this provider must check for the
    // `weixin://` scheme and render the QR component, NOT redirect.
    return { url: codeUrl };
  },

  async createPortalSession(input: PortalInput): Promise<PortalResult> {
    const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
    const url = `${base}/billing/cn-portal?provider=wechat&orgId=${encodeURIComponent(input.orgId)}`;
    return { url };
  },
};

// ─── Inbound notification decryption ───────────────────────────────────────

/**
 * Decrypt the AES-GCM-encrypted `resource` block on a WeChat Pay APIv3
 * notification. The caller passes the verbatim notification JSON; we
 * verify the SDK's signature was already validated upstream (route
 * handler) and return the decrypted plaintext as a parsed object.
 */
export async function decryptWechatNotify(notification: {
  resource: { ciphertext: string; associated_data: string; nonce: string };
}): Promise<unknown> {
  if (!env.WECHAT_PAY_APIV3_KEY) {
    throw new Error('wechat-decrypt-no-apiv3-key');
  }
  const sdk = await getClient();
  const { ciphertext, associated_data, nonce } = notification.resource;
  return sdk.decipher_gcm<unknown>(ciphertext, associated_data, nonce, env.WECHAT_PAY_APIV3_KEY);
}

/** Decode the `attach` field WeChat round-trips for us. */
export function decodeWechatAttach(
  raw: string | undefined,
): { orgId: string; priceId: string } | null {
  if (!raw) return null;
  try {
    const decoded = JSON.parse(raw) as unknown;
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

// ─── Refund helper ────────────────────────────────────────────────────────

export interface WechatRefundInput {
  outRefundNo: string;
  outTradeNo: string;
  refundFen: number; // refund amount in fen
  totalFen: number; // total order amount in fen
  reason?: string;
}

export async function refundWechatCharge(input: WechatRefundInput): Promise<unknown> {
  const sdk = await getClient();
  return sdk.refund({
    out_refund_no: input.outRefundNo,
    out_trade_no: input.outTradeNo,
    amount: {
      refund: input.refundFen,
      total: input.totalFen,
      currency: 'CNY',
    },
    reason: input.reason ?? 'user-requested',
    notify_url: notifyUrl(),
  });
}
