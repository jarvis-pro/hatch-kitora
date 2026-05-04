// RFC 0005 §4.2 — 区域范围的提供者工厂。
//
// "给定部署区域，我们与哪个第三方服务对话？"的单一批准位置。
//
// RFC 0006 PR-2 — CN 提供者现已接线：
//   * email   → Aliyun DirectMail（`src/lib/email/send.ts` 中的 `sendEmail()`
//               分支于 `isCnRegion()` 并分派给
//               sendAliyunDirectMail()）。
//   * storage → `AliyunOssProvider`（`src/lib/storage/index.ts` 中的 `storage` 门面
//               在 `isCnRegion()` 时选择 Aliyun OSS，在
//               尊重 DATA_EXPORT_STORAGE 之前）。
//   * billing → Alipay / WeChat Pay（RFC 0006 PR-3，hosted-checkout +
//               async notify 已上线）。
//
// EU 仍然是占位符：它解析为全局堆栈（Stripe +
// Resend + S3）因为 EU 驻留在"nice to have"轨道上而不是
// hard-blocker 轨道。Light-up 有其自己的后续 RFC。

import 'server-only';

import { Region } from '@prisma/client';

import { getProvider as getStripeBackedBillingProvider } from '@/services/billing/provider';
import type { BillingProvider } from '@/services/billing/provider/types';
import { logger } from '@/lib/logger';
import { currentRegion } from '@/lib/region';
import { storage as defaultStorage } from '@/lib/storage';
import type { StorageProvider } from '@/lib/storage';

/**
 * EU 区域当前没有独立 provider 实现，工厂会回落到 GLOBAL 配置（Stripe / Resend / S3）。
 * 这是 RFC 0005 §11 的「软占位」决定 —— EU 在 nice-to-have 轨道，等独立部署上线
 * 才接入区内 provider（参见后续 RFC）。本地保留一个一次性 warning，让 EU 部署
 * 的运维清楚看到「现在跑的还是 GLOBAL 配置」，避免 GDPR 合规误判。
 */
let euFallbackWarningEmitted = false;
function warnEuFallbackOnce(domain: 'email' | 'storage' | 'billing'): void {
  if (euFallbackWarningEmitted) return;
  euFallbackWarningEmitted = true;
  logger.warn(
    { domain, fallback: 'GLOBAL' },
    'eu-region-provider-fallback-to-global — EU 区暂未实现独立 provider，回退到 GLOBAL 配置',
  );
}

// ─── Email ─────────────────────────────────────────────────────────────────

/**
 * 邮件提供者句柄。
 * @property id - 日志和仪表板的标识符。
 */
export interface EmailProviderHandle {
  readonly id: 'resend' | 'aliyun-direct-mail';
}

const ResendHandle: EmailProviderHandle = { id: 'resend' };
const AliyunDmHandle: EmailProviderHandle = { id: 'aliyun-direct-mail' };

/**
 * 为活跃区域选择电子邮件提供者句柄。实际发送分派
 * 存在于 `src/lib/email/send.ts` 中；这个函数存在所以
 * 仪表板/日志/指标可以读取稳定提供者 id 而无需
 * 拉入 SDK。
 */
export function getEmailProvider(): EmailProviderHandle {
  switch (currentRegion()) {
    case Region.CN:
      return AliyunDmHandle;
    case Region.EU:
      warnEuFallbackOnce('email');
      return ResendHandle;
    case Region.GLOBAL:
    default:
      return ResendHandle;
  }
}

// ─── Storage ───────────────────────────────────────────────────────────────

/**
 * 为活跃区域选择对象存储后端。
 *
 * 返回现有 RFC 0002 PR-3 存储门面。门面本身
 * 是区域感知的（`isCnRegion()` 短路到 AliyunOssProvider
 * 在检查 DATA_EXPORT_STORAGE 之前），所以这个重新导出保留了
 * RFC 0005 §4.2 中的"提供者都挂在一个工厂"承诺。
 */
export function getStorageProvider(): StorageProvider {
  switch (currentRegion()) {
    case Region.EU:
      warnEuFallbackOnce('storage');
      return defaultStorage;
    case Region.CN:
    case Region.GLOBAL:
    default:
      return defaultStorage;
  }
}

// ─── Billing ───────────────────────────────────────────────────────────────

/**
 * 为活跃区域选择计费提供者。
 *
 * 委托给现有 `src/lib/billing/provider` 工厂
 * 已理解 Stripe（GLOBAL）/ Alipay + WeChat Pay（CN）。这个
 * 重新导出存在以便 RFC 0005 的"提供者都挂在一个工厂"
 * 承诺是真的 — 调用位置从 `@/lib/region/providers`
 * 导入，无论提供者域。
 */
export function getBillingProvider(): BillingProvider {
  if (currentRegion() === Region.EU) warnEuFallbackOnce('billing');
  return getStripeBackedBillingProvider();
}
