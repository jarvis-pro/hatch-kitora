#!/usr/bin/env tsx
/**
 * RFC 0003 PR-2 — 出站 Webhook cron worker（CLI 入口）。
 *
 * 通过 Vercel / Fly cron 每分钟运行一次：
 *   pnpm tsx scripts/run-webhook-cron.ts
 *
 * 实际逻辑位于 `src/lib/webhooks/cron.ts`，这样 e2e 测试可以在进程内
 * 驱动它，无需动态 ESM import（Playwright + tsx 对临时 TS import 的模块
 * 类型处理存在分歧）。本脚本只是一个薄包装，失败时以非零退出码终止。
 */

import { logger } from '@/lib/logger';
import { runWebhookCronTick } from '@/lib/webhooks/cron';

runWebhookCronTick()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'run-webhook-cron-fatal');
    process.exit(1);
  });
