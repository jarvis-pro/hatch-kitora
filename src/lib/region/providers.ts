// RFC 0005 §4.2 — Region-scoped provider factory.
//
// Single sanctioned spot for "given the deploy region, which third-party
// service do we talk to?"
//
// RFC 0006 PR-2 — CN providers are now wired:
//   * email   → Aliyun DirectMail (`sendEmail()` in src/lib/email/send.ts
//               branches on `isCnRegion()` and dispatches to
//               sendAliyunDirectMail()).
//   * storage → `AliyunOssProvider` (the `storage` facade in
//               src/lib/storage/index.ts picks Aliyun OSS when
//               `isCnRegion()`, before honouring DATA_EXPORT_STORAGE).
//   * billing → Alipay / WeChat Pay (RFC 0006 PR-3, hosted-checkout +
//               async notify already live).
//
// EU stays a placeholder: it resolves to the global stack (Stripe +
// Resend + S3) since EU residency is on the "nice to have" track rather
// than the hard-blocker track. Light-up has its own follow-up RFC.

import 'server-only';

import { Region } from '@prisma/client';

import { getProvider as getStripeBackedBillingProvider } from '@/lib/billing/provider';
import type { BillingProvider } from '@/lib/billing/provider/types';
import { currentRegion } from '@/lib/region';
import { storage as defaultStorage } from '@/lib/storage';
import type { StorageProvider } from '@/lib/storage';

// ─── Email ─────────────────────────────────────────────────────────────────

export interface EmailProviderHandle {
  /** Identifier for logs / dashboards. */
  readonly id: 'resend' | 'aliyun-direct-mail';
}

const ResendHandle: EmailProviderHandle = { id: 'resend' };
const AliyunDmHandle: EmailProviderHandle = { id: 'aliyun-direct-mail' };

/**
 * Pick the email provider handle for the active region. The actual send
 * dispatch lives in `src/lib/email/send.ts`; this function exists so
 * dashboards / logs / metrics can read a stable provider id without
 * pulling in the SDK.
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
 * Pick the object-storage backend for the active region.
 *
 * Returns the existing RFC 0002 PR-3 storage facade. The facade itself
 * is region-aware (`isCnRegion()` short-circuits to AliyunOssProvider
 * before checking DATA_EXPORT_STORAGE), so this re-export keeps the
 * "providers all hang off one factory" promise from RFC 0005 §4.2.
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
 * Pick the billing provider for the active region.
 *
 * Delegates to the existing `src/lib/billing/provider` factory which
 * already understands Stripe (GLOBAL) / Alipay + WeChat Pay (CN). This
 * re-export exists so RFC 0005's "providers all hang off one factory"
 * promise is true — call sites import from `@/lib/region/providers`
 * regardless of provider domain.
 */
export function getBillingProvider(): BillingProvider {
  return getStripeBackedBillingProvider();
}
