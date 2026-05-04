/**
 * RFC 0008 §4.3 / §4.5 — Schedule 投影主入口。
 *
 * `fireSchedules()` 在每次 worker tick 头部调一次：
 *
 *   1. 拿当前时间向下取整到分钟（`floorToUnixMinute`）；
 *   2. 遍历 ScheduleRegistry 中所有 schedule，对每个判断 `matchesCron(cron, now)`；
 *   3. 匹配的 schedule 调 `enqueueJob(jobType, payload, { runId: 'schedule:<name>:<unixMinute>' })`。
 *
 * 同一分钟重复调用 `fireSchedules()` 是天然幂等的 —— `runId` 的 unix-minute
 * 后缀加上 `(type, runId)` unique 索引让第二次 enqueue 走 P2002 swallow，
 * 落到既存行 / 不重复创建。这是 RFC 0008 §4.3 写明的「重复触发去重」机制。
 *
 * **不调度领域 sweep 自身**：webhook.tick / export.tick / deletion.tick 这三个
 * job 的 run 函数才是去调用既有 sweep（runWebhookCronTick 等）；fireSchedules
 * 只负责把 schedule → BackgroundJob 行的投影动作。
 */

import { enqueueJob } from './enqueue';
import { floorToUnixMinute, matchesCron } from './cron';
import { listSchedules } from './registry';
import { logger } from '@/lib/logger';

export interface FireSchedulesResult {
  /** 当前 unix-minute（用于 runId 后缀去重）。 */
  unixMinute: number;
  /** schedules 注册表中匹配本分钟的 schedule 名字。 */
  matched: string[];
  /** 实际执行 enqueue 后落地为新行的（deduplicated=false）。 */
  enqueued: string[];
  /** 因 P2002 swallow 复用既存行的（deduplicated=true）—— 同分钟二次调用是这里。 */
  deduplicated: string[];
}

/**
 * 把当前分钟匹配的 schedule 投影成 BackgroundJob 行。返回计数明细，
 * 调用方（runWorkerTick / `/api/jobs/tick` / `scripts/run-jobs.ts`）可以
 * logger.info 打底用。
 *
 * `now` 参数仅供单测注入；生产从 `new Date()` 走默认。
 */
export async function fireSchedules(now: Date = new Date()): Promise<FireSchedulesResult> {
  const unixMinute = floorToUnixMinute(now);
  const schedules = listSchedules();
  const matched: string[] = [];
  const enqueued: string[] = [];
  const deduplicated: string[] = [];

  for (const sched of schedules) {
    if (!matchesCron(sched.cron, now)) continue;
    matched.push(sched.name);

    const runId = `schedule:${sched.name}:${unixMinute}`;
    try {
      const result = await enqueueJob(sched.jobType, sched.payload, { runId });
      if (result.deduplicated) {
        deduplicated.push(sched.name);
      } else {
        enqueued.push(sched.name);
      }
    } catch (err) {
      // schedule 触发失败不阻塞其它 schedule —— logger.error 后继续。
      // 常见原因：jobType 未注册（bootstrap.ts 漏 import）、payload zod 校验失败
      // （schedule.payload 与 defineJob.payloadSchema 形状不一致）。
      logger.error(
        { err, schedule: sched.name, jobType: sched.jobType, runId },
        'fire-schedule-enqueue-failed',
      );
    }
  }

  if (matched.length > 0) {
    logger.info({ unixMinute, matched, enqueued, deduplicated }, 'fire-schedules-tick');
  }

  return { unixMinute, matched, enqueued, deduplicated };
}
