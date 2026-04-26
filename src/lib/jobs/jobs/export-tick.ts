/**
 * RFC 0008 §4.3 / §4.6 — `export.tick` wrapper job。
 *
 * 每分钟由 `fireSchedules()` 投递一行；run handler 调既有 `runExportJobsTick()`
 * （src/lib/data-export/cron.ts，RFC 0008 PR-2 commit 1 抽出 lib）。原 export
 * 状态机（PENDING → RUNNING → COMPLETED / FAILED / EXPIRED）保留不动。
 *
 * `maxAttempts: 1`：与 webhook.tick 同款语义 —— 失败下一分钟自然会再来。
 * `timeoutMs: 45_000`：单次 export 涉及 zip 构建 + S3 PUT，耗时不稳定，给宽预算。
 */

import { z } from 'zod';

import { defineJob, defineSchedule } from '@/lib/jobs/define';
import { runExportJobsTick } from '@/lib/data-export/cron';

export const exportTickJob = defineJob({
  type: 'export.tick',
  payloadSchema: z.object({}).strict(),
  maxAttempts: 1,
  retentionDays: 1,
  retry: 'fixed',
  timeoutMs: 45_000,
  async run() {
    await runExportJobsTick();
    return null;
  },
});

defineSchedule({
  name: 'export-sweep',
  cron: '* * * * *', // 每分钟
  jobType: 'export.tick',
});
