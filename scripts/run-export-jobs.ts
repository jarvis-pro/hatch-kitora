#!/usr/bin/env tsx
/**
 * RFC 0002 PR-3 / RFC 0008 PR-2 — data export cron worker (CLI entry).
 *
 * Run from a Vercel / Fly cron every minute:
 *   pnpm tsx scripts/run-export-jobs.ts
 *
 * The actual logic lives in `src/lib/data-export/cron.ts` so e2e tests can
 * drive it in-process and the new `export.tick` BackgroundJob wrapper
 * (RFC 0008) can call the same function. This script is a thin shim that
 * resolves to a non-zero exit code on failure.
 *
 * NOTE: With RFC 0008 PR-4 the recommended cron entry becomes
 * `pnpm tsx scripts/run-jobs.ts` (single CLI fanning out to all schedules).
 * This shim is kept for one deprecation window so existing Vercel / Fly
 * cron configs migrate at their own pace.
 */

import { logger } from '@/lib/logger';
import { runExportJobsTick } from '@/lib/data-export/cron';

runExportJobsTick()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'run-export-jobs-fatal');
    process.exit(1);
  });
