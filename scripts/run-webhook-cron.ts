#!/usr/bin/env tsx
/**
 * RFC 0003 PR-2 — outbound webhook cron worker (CLI entry).
 *
 * Run from a Vercel / Fly cron every minute:
 *   pnpm tsx scripts/run-webhook-cron.ts
 *
 * The actual logic lives in `src/lib/webhooks/cron.ts` so e2e tests can
 * drive it in-process without a dynamic ESM import (Playwright + tsx
 * disagree on module type for ad-hoc TS imports). This script is just a
 * thin wrapper that resolves to a non-zero exit code on failure.
 */

import { logger } from '@/lib/logger';
import { runWebhookCronTick } from '@/lib/webhooks/cron';

runWebhookCronTick()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'run-webhook-cron-fatal');
    process.exit(1);
  });
