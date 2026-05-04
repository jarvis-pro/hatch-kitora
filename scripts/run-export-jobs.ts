#!/usr/bin/env tsx
/**
 * RFC 0002 PR-3 / RFC 0008 PR-2 — 数据导出 cron worker（CLI 入口）。
 *
 * 通过 Vercel / Fly cron 每分钟运行一次：
 *   pnpm tsx scripts/run-export-jobs.ts
 *
 * 实际逻辑位于 `src/lib/data-export/cron.ts`，这样 e2e 测试可以
 * 在进程内驱动它，新的 `export.tick` BackgroundJob 包装器（RFC 0008）
 * 也可以调用同一个函数。本脚本是一个薄垫片，失败时以非零退出码终止。
 *
 * 注意：RFC 0008 PR-4 落地后，推荐的 cron 入口改为
 * `pnpm tsx scripts/run-jobs.ts`（单一 CLI 统一分发所有 schedule）。
 * 本垫片保留一个废弃窗口，供现有 Vercel / Fly cron 配置按自己节奏迁移。
 */

import { logger } from '@/lib/logger';
import { runExportJobsTick } from '@/services/data-export/cron';

runExportJobsTick()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'run-export-jobs-fatal');
    process.exit(1);
  });
