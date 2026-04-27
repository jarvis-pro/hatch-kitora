// RFC 0006 PR-3 — 微信支付账单提供商（Native pay，APIv3）。
//
// 包装社区维护的 `wechatpay-node-v3` SDK。v1 仅支持
// Native pay（二维码扫码）— JSAPI / 小程序 / H5 流推迟到
// 后续 RFC。从 BillingProvider 契约的角度：
//
//   * createCheckoutSession 返回一个 `code_url`（一个 `weixin://` URI）。
//     调用者是前端 QR 码组件，它将 URI 呈现为模式内的 QR 图像。
//     我们不将浏览器重定向到 `code_url` — 这不是可导航的 URL。
//   * createPortalSession 返回自托管 `/billing/cn-portal` URL，
//     与支付宝情况对称（不存在本机门户）。
//
// 入站通知在 `resource.ciphertext` 下携带 AES-GCM 密文；
// `decryptWechatNotify` 为路由处理程序公开解密辅助函数。

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

// ─── SDK 形状（最小本地视图） ────────────────────────────────────────
//
// 我们仅模拟我们实际调用的表面。社区 SDK 在构造函数参数名称方面
// 有历史沧桑；本地接口使此文件的其余部分与这些漂移隔离。

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

// ─── 延迟 SDK 初始化 ─────────────────────────────────────────────────────────

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
  // 社区 SDK 的已发布类型声称一个 4 位置参数构造函数，
  // 但 README + 大多数社区用法传递一个单一的配置对象。
  // 我们通过 `unknown` 投射以使类型系统沉默；投射声明
  // 我们的 `WxPayClientLike` 是我们实际调用的*运行时*形状，
  // 不管 SDK 的 d.ts 文件如何描述它。如果 SDK 的运行时契约改变
  // （它已经改变了，反复地），这个模块在第一次结账/通知时快速失败
  // 并且我们重新审视。
  const Ctor = ((mod as unknown as { default?: new (cfg: unknown) => WxPayClientLike }).default ??
    (mod as unknown as { WxPay?: new (cfg: unknown) => WxPayClientLike }).WxPay) as new (
    cfg: unknown,
  ) => WxPayClientLike;

  _client = new Ctor({
    appid: env.WECHAT_PAY_APP_ID,
    mchid: env.WECHAT_PAY_MCH_ID,
    publicKey: Buffer.from('', 'utf8'), // SDK 自动获取平台证书
    privateKey: Buffer.from(env.WECHAT_PAY_MERCHANT_PRIVATE_KEY ?? '', 'utf8'),
    serial_no: env.WECHAT_PAY_MERCHANT_SERIAL_NO,
    key: env.WECHAT_PAY_APIV3_KEY,
  });

  return _client;
}

// ─── 辅助函数 ───────────────────────────────────────────────────────────────

function buildOutTradeNo(orgId: string): string {
  // WeChat 的 32 字符限制（比支付宝的 64 更严格）。
  // 11 + cuid (25) 已经太长，所以我们仅使用 cuid 后缀。
  const suffix = orgId.slice(-12);
  return `kt-${suffix}-${Date.now()}`;
}

function notifyUrl(): string {
  const base = env.CN_PUBLIC_API_URL ?? env.NEXT_PUBLIC_APP_URL;
  return `${base.replace(/\/+$/, '')}/api/billing/wechat/notify`;
}

// ─── 提供商实现 ───────────────────────────────────────────────────────────────

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
        // 微信金额单位是分（1/100 CNY）。乘以 100 + 舍入
        // 以避免诸如 99.99 这样的价格浮点漂移。
        total: Math.round(price.amount * 100),
        currency: 'CNY',
      },
      attach: JSON.stringify({ orgId: input.orgId, priceId: input.priceId }),
    });

    // 不同的 SDK 版本返回 `code_url` 平面或嵌套在
    // `data.code_url` 下。接受两者。
    const codeUrl = result.code_url ?? result.data?.code_url;
    if (!codeUrl) {
      logger.error({ result }, 'wechat-native-no-code-url');
      throw new Error('wechat-native-no-code-url');
    }

    logger.info(
      { orgId: input.orgId, priceId: input.priceId, outTradeNo },
      'wechat-checkout-created',
    );

    // 契约是 `{ url: string }` — 对于微信 Native，这个 URL 是
    // 一个 `weixin://` URI 在前端呈现为 QR 码。
    // 点击此提供商的 CN 区域调用者必须检查 `weixin://` 方案
    // 并呈现 QR 组件，不能重定向。
    return { url: codeUrl };
  },

  async createPortalSession(input: PortalInput): Promise<PortalResult> {
    const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
    const url = `${base}/billing/cn-portal?provider=wechat&orgId=${encodeURIComponent(input.orgId)}`;
    return { url };
  },
};

// ─── 入站通知解密 ───────────────────────────────────────────────────────────────

/**
 * 解密微信支付 APIv3 通知上的 AES-GCM 加密 `resource` 块。
 * 调用者传递逐字通知 JSON；我们验证 SDK 的签名已在上游
 * （路由处理程序）验证，并将解密的纯文本作为解析的对象返回。
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

/** 解码微信为我们往返的 `attach` 字段。 */
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

// ─── 退款辅助函数 ────────────────────────────────────────────────────────

export interface WechatRefundInput {
  outRefundNo: string;
  outTradeNo: string;
  refundFen: number; // 以分为单位的退款金额
  totalFen: number; // 以分为单位的订单总金额
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
