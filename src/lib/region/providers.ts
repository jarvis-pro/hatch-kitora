// RFC 0005 §4.2 — Region-scoped provider factory.
//
// Single sanctioned spot for "given the deploy region, which third-party
// service do we talk to?" Today the global region is the only one that
// resolves to working providers; CN throws `not-implemented in v0.6.0`
// per RFC 0005 §4.2 — that error is on purpose, it forces RFC 0006 to
// wire all three CN providers (Aliyun OSS / Aliyun DirectMail /
// Alipay-or-WeChat-Pay) before a CN stack can boot a paying flow.
//
// EU is the same shape: the placeholder enum value resolves to the
// global stack today (Stripe + Resend + S3) since EU residency is on the
// "nice to have" track rather than the hard-blocker track.

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

/**
 * Pick the email provider for the active region.
 *
 * The actual `sendEmail()` implementation in `src/lib/email/send.ts`
 * always uses Resend today. RFC 0006 will introduce
 * `aliyun-direct-mail.ts` and dispatch through this handle.
 */
export function getEmailProvider(): EmailProviderHandle {
  switch (currentRegion()) {
    case Region.CN:
      throw new Error('cn-email-provider-not-implemented — RFC 0006 wires Aliyun DirectMail');
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
 * Returns the existing RFC 0002 PR-3 storage facade for GLOBAL/EU; CN is
 * intentionally unimplemented until RFC 0006 plumbs Aliyun OSS.
 */
export function getStorageProvider(): StorageProvider {
  switch (currentRegion()) {
    case Region.CN:
      throw new Error('cn-storage-provider-not-implemented — RFC 0006 wires Aliyun OSS');
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
