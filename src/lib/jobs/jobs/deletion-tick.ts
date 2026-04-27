/**
 * RFC 0008 §4.3 / §4.6 — `deletion.tick` wrapper job。
 *
 * 每天 UTC 03:00 由 `fireSchedules()` 投递一行；run handler 调既有
 * `runDeletionCronTick()`（src/lib/account/deletion-cron.ts，RFC 0008 PR-2
 * commit 2 抽出 lib）。User PENDING_DELETION → hard-delete 状态机保留不动。
 *
 * cron 时区注意：`'0 3 * * *'` 是 **UTC** 03:00 = CN 11:00。如果 ops 期望
 * 北京时间凌晨 3:00 跑，写 `'0 19 * * *'`（前一天 UTC 19:00）。RFC 0008 §10
 * 写明 schedule 用 UTC 让多 region 部署语义一致。
 *
 * 这是「批量行级事务 + audit + 依赖 cascade」的活，给较宽的 60s 预算 —— 200
 * 行用户每条 ~200ms 总 40s。
 */

import { z } from 'zod';

import { defineJob, defineSchedule } from '@/lib/jobs/define';
import { runDeletionCronTick } from '@/lib/account/deletion-cron';

export const deletionTickJob = defineJob({
  type: 'deletion.tick',
  payloadSchema: z.object({}).strict(),
  maxAttempts: 1,
  retentionDays: 7,
  retry: 'fixed',
  timeoutMs: 60_000,
  async run() {
    await runDeletionCronTick();
    return null;
  },
});

defineSchedule({
  name: 'deletion-cron',
  cron: '0 3 * * *', // UTC 每天 03:00
  jobType: 'deletion.tick',
});
