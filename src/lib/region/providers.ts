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

import { getProvider as getStripeBackedBillingProvider } from '@/lib/billing/provider';
import type { BillingProvider } from '@/lib/billing/provider/types';
import { currentRegion } from '@/lib/region';
import { storage as defaultStorage } from '@/lib/storage';
import type { StorageProvider } from '@/lib/storage';

// ─── Email ─────────────────────────────────────────────────────────────────

export interface EmailProviderHandle {
  /** 日志/仪表板的标识符。 */
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
    case Region.CN:
    case Region.EU:
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
  return getStripeBackedBillingProvider();
}
