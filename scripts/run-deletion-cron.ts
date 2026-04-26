#!/usr/bin/env tsx
/**
 * RFC 0002 PR-4 / RFC 0008 PR-2 — daily deletion cron worker (CLI entry).
 *
 * Run from Vercel / Fly cron once a day:
 *   pnpm tsx scripts/run-deletion-cron.ts
 *
 * The actual logic lives in `src/lib/account/deletion-cron.ts` so e2e tests
 * can drive it in-process and the new `deletion.tick` BackgroundJob wrapper
 * (RFC 0008) can call the same function. This script is a thin shim that
 * resolves to a non-zero exit code on failure.
 *
 * NOTE: With RFC 0008 PR-4 the recommended cron entry becomes
 * `pnpm tsx scripts/run-jobs.ts` (single CLI fanning out to all schedules).
 * This shim is kept for one deprecation window so existing Vercel / Fly
 * cron configs migrate at their own pace.
 */

import { logger } from '@/lib/logger';
import { runDeletionCronTick } from '@/lib/account/deletion-cron';

runDeletionCronTick()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'run-deletion-cron-fatal');
    process.exit(1);
  });
