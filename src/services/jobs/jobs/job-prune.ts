/**
 * RFC 0008 §3.1 / §4.6 / §7 / PR-3 — BackgroundJob 表过期终态行清理。
 *
 * 终态行（SUCCEEDED / FAILED / DEAD_LETTER / CANCELED）在写终态时 runner.ts
 * 已根据 `defineJob.retentionDays` 算好 `deleteAt = completedAt + retentionDays`
 * 写进列。本 job 单一职责：扫 `deleteAt < now()` 一刀清掉。
 *
 * 不参与 `lastError` / DEAD_LETTER 的统计 —— 那是 admin 翻 history 的事，过了
 * retention 就不再有调试价值。
 *
 * 为什么不直接把 retention 写进 `runner.ts` 的写终态语句、用 PG row TTL：
 *   PG 没有原生 row TTL；写一个 daily sweep 是惯例；保留 deleteAt 列让 admin
 *   能临时调高某行的保留期（PR-4 admin UI 暴露）。
 *
 * `maxAttempts: 1` + `retry: 'fixed'`：失败下一天再跑就行；deleteMany 累积失败
 * 的成本远低于反复重试。`timeoutMs: 60_000`：给 deleteMany 充裕预算
 * （若一天积压数十万行也能在 1 分钟内完成）。
 *
 * Schedule：每天 UTC 04:00 = CN 12:00（避开 deletion-cron 的 UTC 03:00 / CN 11:00 高峰）。
 */

import { z } from 'zod';

import { defineJob, defineSchedule } from '@/services/jobs/define';
import { prisma } from '@/lib/db';

interface JobPruneResult {
  deleted: number;
}

export const jobPruneJob = defineJob({
  type: 'job.prune',
  payloadSchema: z.object({}).strict(),
  maxAttempts: 1,
  retentionDays: 7,
  retry: 'fixed',
  timeoutMs: 60_000,
  async run({ logger }): Promise<JobPruneResult> {
    const result = await prisma.backgroundJob.deleteMany({
      where: {
        // status 限定在终态：避免误删 PENDING / RUNNING（理论上不该 deleteAt
        // 不为空，但 defensive）。
        status: { in: ['SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'CANCELED'] },
        deleteAt: { lt: new Date(), not: null },
      },
    });

    if (result.count > 0) {
      logger.info({ count: result.count }, 'job-prune-deleted');
    }
    return { deleted: result.count };
  },
});

defineSchedule({
  name: 'job-prune',
  cron: '0 4 * * *', // 每天 UTC 04:00
  jobType: 'job.prune',
});
