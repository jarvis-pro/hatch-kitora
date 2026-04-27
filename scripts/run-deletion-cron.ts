#!/usr/bin/env tsx
/**
 * RFC 0002 PR-4 / RFC 0008 PR-2 — 每日账号删除 cron worker（CLI 入口）。
 *
 * 通过 Vercel / Fly cron 每天运行一次：
 *   pnpm tsx scripts/run-deletion-cron.ts
 *
 * 实际逻辑位于 `src/lib/account/deletion-cron.ts`，这样 e2e 测试可以
 * 在进程内驱动它，新的 `deletion.tick` BackgroundJob 包装器（RFC 0008）
 * 也可以调用同一个函数。本脚本是一个薄垫片，失败时以非零退出码终止。
 *
 * 注意：RFC 0008 PR-4 落地后，推荐的 cron 入口改为
 * `pnpm tsx scripts/run-jobs.ts`（单一 CLI 统一分发所有 schedule）。
 * 本垫片保留一个废弃窗口，供现有 Vercel / Fly cron 配置按自己节奏迁移。
 */

import { logger } from '@/lib/logger';
import { runDeletionCronTick } from '@/lib/account/deletion-cron';

runDeletionCronTick()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'run-deletion-cron-fatal');
    process.exit(1);
  });
