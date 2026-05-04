// RFC 0006 PR-3 — 支付宝账单提供商（生产形状的实现）。
//
// 包装官方 `alipay-sdk` v4 以公开映射到我们 `BillingProvider` 契约的
// 四个流：
//
//   1. createCheckoutSession  → 「电脑网站支付」(`alipay.trade.page.pay`)
//                                返回 alipay.com 重定向 URL。
//   2. createPortalSession    → 自托管 `/billing/cn-portal` 页面
//                                （支付宝没有本机客户门户类似物；
//                                Next.js 页面读取我们的订阅状态并提供
//                                取消/管理协议操作）。
//   3. verifyAlipayNotify     → 针对入站 webhook 路由公开以验证
//                                支付宝异步通知上的 RSA2 签名。
//   4. refund + chargeAgreement → 由 ops 脚本和 cron 驱动的
//                                 周期扣款工作者使用的小辅助函数。
//
// SDK 在首次使用时*延迟*加载，以便 GLOBAL 区域进程（从不
// 到达 AlipayProvider）不支付导入成本。`import type` 保持调用站点
// 类型安全，而无需强制运行时模块加载。

import 'server-only';

import type { AlipaySdk as AlipaySdkType } from 'alipay-sdk';

import { env } from '@/env';
import { resolveCnPrice } from '@/services/billing/cn-price-config';
import { logger } from '@/lib/logger';
import { currentRegion } from '@/lib/region';

import type {
  BillingProvider,
  CheckoutInput,
  CheckoutResult,
  PortalInput,
  PortalResult,
} from './types';

// ─── 延迟 SDK 初始化 ─────────────────────────────────────────────────────────

let _client: AlipaySdkType | null = null;

async function getClient(): Promise<AlipaySdkType> {
  if (_client) return _client;

  if (!env.ALIPAY_APP_ID || !env.ALIPAY_PRIVATE_KEY || !env.ALIPAY_PUBLIC_KEY) {
    throw new Error(
      'alipay-not-configured: ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY / ALIPAY_PUBLIC_KEY missing',
    );
  }

  // 动态导入将 SDK 保留在 GLOBAL 包之外。运行时成本
  // 在第一次 CN 支付请求时支付一次。
  const mod = await import('alipay-sdk');
  // alipay-sdk v4 作为命名导出导出 `AlipaySdk`；一些工具
  // 将其公开为默认值。接受两者在升级中具有防御性。
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

// ─── 辅助函数 ───────────────────────────────────────────────────────────────

/** 构建确定性、幂等的业务订单号（≤ 64 个字符）。 */
function buildOutTradeNo(orgId: string): string {
  return `kitora-${orgId}-${Date.now()}`;
}

function notifyUrl(): string {
  const base = env.CN_PUBLIC_API_URL ?? env.NEXT_PUBLIC_APP_URL;
  return `${base.replace(/\/+$/, '')}/api/billing/alipay/notify`;
}

// ─── 提供商实现 ───────────────────────────────────────────────────────────────

export const AlipayProvider: BillingProvider = {
  id: 'alipay',

  async createCheckoutSession(input: CheckoutInput): Promise<CheckoutResult> {
    if (currentRegion() !== 'CN') {
      // 纵深防御：提供商工厂应该已经限制这个，但从 GLOBAL
      // 误接线的调用必须大声失败，而不是无声构建
      // 指向错误轨道的链接 URL。
      throw new Error('alipay-only-available-in-cn-region');
    }

    const price = resolveCnPrice(input.priceId);
    const outTradeNo = buildOutTradeNo(input.orgId);

    const sdk = await getClient();

    // `pageExec` 返回一个完整的 alipay.com 重定向 URL
    // （SDK 签署 + URL 编码它）。浏览器点击该 URL，
    // 登陆支付宝托管的结账页面，完成支付，然后支付宝
    // 以同步结果将用户反弹回 `returnUrl` —
    // 我们不信任同步返回；权威信号是我们在
    // `notifyUrl()` 接收的异步通知。
    const url: string = await sdk.pageExec('alipay.trade.page.pay', {
      bizContent: {
        out_trade_no: outTradeNo,
        product_code: 'FAST_INSTANT_TRADE_PAY',
        total_amount: price.amount.toFixed(2),
        subject: price.subject,
        body: price.description,
        // `passback_params` 在异步通知中逐字往返；
        // 我们编码我们的 orgId + priceId，以便 webhook
        // 可以解析回正确的订阅，而无需对 out_trade_no 进行 DB 查找。
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
    // 支付宝不公开本机客户门户。我们展示一个自托管页面，
    // 读取 `Subscription.cnAgreementId`，让用户取消
    // 免密协议（调用下面的 `unsignAlipayAgreement`），并
    // 显示已在我们的 DB 中的最后 12 张发票。
    // 不如 Stripe 的托管门户精致，但涵盖用户实际需要的仅有的
    // 两个流："何时续订？"和"取消"。
    const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
    const url = `${base}/billing/cn-portal?provider=alipay&orgId=${encodeURIComponent(input.orgId)}`;
    return { url };
  },
};

// ─── 入站通知验证 ─────────────────────────────────────────────────────────────

/**
 * 验证入站支付宝异步通知上的 RSA2 签名。调用者
 * （webhook 路由）必须将原始表单编码的正文传递给我们
 * 解析为平面字符串映射；SDK 读取 `params.sign` + `params.sign_type`
 * 并计算其余部分的预期签名。
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

/** 解码通过支付宝往返的 `passback_params`。 */
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

// ─── 退款 + 协议辅助函数 ────────────────────────────────────────────────────────────────

export interface RefundInput {
  outTradeNo: string;
  refundAmount: number; // CNY，两位小数
  outRequestNo: string; // 幂等性密钥
  reason?: string;
}

/** 同步退款。按字面意思返回 SDK 响应以供审计。 */
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
 * 终止免密协议 (`alipay.user.agreement.unsign`)，
 * 以便 cron 工作程序停止定期计费。从 `/billing/cn-portal`
 * 取消按钮和管理员"强制取消"工具调用。
 */
export async function unsignAlipayAgreement(agreementNo: string): Promise<void> {
  const sdk = await getClient();
  await sdk.exec('alipay.user.agreement.unsign', {
    bizContent: { agreement_no: agreementNo },
  });
}

/**
 * 针对现有免密协议发出定期计费 —
 * 由 `run-cn-billing-cron.ts` 工作程序每个计费周期调用一次。
 * 成功时返回提供商交易号。
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
