#!/usr/bin/env tsx
/**
 * RFC 0008 §4.5 / PR-2 — Background jobs 单一 CLI 入口。
 *
 * 部署侧只需要在 cron 配置里写一条：
 *
 *   pnpm tsx scripts/run-jobs.ts
 *
 * 一次 tick 两阶段：
 *
 *   1. **fireSchedules** —— 投影到点的 schedule（webhook-sweep / export-sweep /
 *      deletion-cron / token-cleanup [PR-3] / job-prune [PR-3]）成 BackgroundJob 行。
 *      runId = `schedule:<name>:<unixMinute>` 让多 worker / 重复 tick 自然走 P2002 swallow。
 *
 *   2. **runWorkerTick** —— `FOR UPDATE SKIP LOCKED` 抢一批 PENDING 行跑掉；
 *      claim/run/重试/DLQ/崩溃恢复全部由 src/lib/jobs/runner.ts 处理。
 *
 * `pruneCompletedJobs` 不在这里直接调 —— PR-3 把它实现为 `job.prune` job，
 * 通过 `defineSchedule({ name: 'job-prune', cron: '0 4 * * *' })` 让 fireSchedules
 * 自动每天 UTC 04:00 投递。本入口不需要改。
 *
 * 部署位置（RFC 0008 §5.1）：
 *   - Vercel Cron：`/api/jobs/tick` 路由（PR-4）内部调同款 fireSchedules + runWorkerTick；
 *   - Fly Machines Cron：`fly.toml` 直跑此 CLI；
 *   - Aliyun ACK CronJob：`infra/aliyun/cronjob.yaml` 直跑此 CLI（PR-4 / RFC 0006 follow-up）。
 *
 * 旧脚本 `run-webhook-cron.ts` / `run-export-jobs.ts` / `run-deletion-cron.ts`
 * 仍保留作为 thin shim（RFC 0008 §4.5 / §6.1 回滚通道）—— 现有部署可以无缝迁移到
 * `run-jobs.ts`，等下一个 minor 再删旧脚本。
 */

import '@/lib/jobs/bootstrap';

import { logger } from '@/lib/logger';
import { runWorkerTick } from '@/lib/jobs/runner';
import { fireSchedules } from '@/lib/jobs/schedules';

async function main() {
  const workerId = `worker-${process.pid}-${Date.now()}`;

  // 1. 投影到点的 schedule（webhook / export / deletion / 后续新加的）。
  const sched = await fireSchedules();

  // 2. 抢一批 PENDING 行跑。Vercel Pro 60s function timeout 留 50s 给 tick，
  //    单 job 默认 8s timeout，安全余量充足。需要更紧（Hobby 10s）时调
  //    `runWorkerTick(workerId, { budgetMs: 8_000, batchSize: 1 })`。
  const tick = await runWorkerTick(workerId);

  logger.info({ workerId, sched, tick }, 'run-jobs-tick-done');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'run-jobs-fatal');
    process.exit(1);
  });
