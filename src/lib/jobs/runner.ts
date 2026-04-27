/**
 * RFC 0008 §4.4 / §5 — Worker tick 主循环。
 *
 * 一次 tick 三阶段：
 *
 *   1. **Recover stuck** — RUNNING + `lockedAt < now() - LOCK_TIMEOUT` 翻回 PENDING。
 *      这是「上一个 worker 跑到一半进程被杀」的兜底。
 *
 *   2. **Claim + run** — 用 PostgreSQL `FOR UPDATE SKIP LOCKED` 抢 batch 行。
 *      多 worker 并发跑同一个 tick 不会互锁，也不会重复抢同一行（钢底）。
 *      每个 claimed job：
 *        - 反查 registry 找 handler（找不到 → 直接 DEAD_LETTER）；
 *        - zod re-validate payload（防御性二道防线）；
 *        - `Promise.race(handler, timeout)`；
 *        - 成功：写 SUCCEEDED + result + deleteAt；
 *        - 失败 + 还有重试：写 PENDING + nextAttemptAt + lastError；
 *        - 失败 + 用尽重试：写 DEAD_LETTER + lastError + deleteAt。
 *
 *   3. **Budget guard** — 每抢一批前看剩余时间是否 < 5s；不够就停手让本次 tick 优雅
 *      结束（剩下的下次 tick 自然接上）。这是给 Vercel function timeout（Pro 60s）
 *      留余量。
 *
 * `runWorkerTick` 不调 `fireSchedules` / `pruneCompletedJobs` — 这两件事在 PR-2
 * 的 `scripts/run-jobs.ts` / `/api/jobs/tick` 入口编排，runner 保持单一职责。
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

import { withJobTransaction, jobMetrics } from './observability';
import { getJob } from './registry';
import { nextRetryDelayMs } from './retry';

const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 5;
/**
 * 一次 tick 给 50s 预算（Vercel Pro 60s function timeout 留 10s 兜底）。
 * 通过 `runWorkerTick(workerId, { budgetMs: ... })` 在 Hobby（10s）环境下覆盖。
 */
const DEFAULT_TICK_BUDGET_MS = 50_000;
/**
 * 剩余预算 < 这个阈值时不再 claim 新 batch — 留给已 claim 的 job 写完终态。
 */
const CLAIM_TAIL_GUARD_MS = 5_000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ERROR_TRUNCATE_BYTES = 2_000;

/**
 * Worker tick 选项。
 * @property batchSize - 每次声称的任务数；默认 5。
 * @property budgetMs - Tick 时间预算（毫秒）；默认 50_000。
 * @property lockTimeoutMs - 锁定超时时间；默认 5 分钟。
 * @property queue - 声称任务的队列名；默认 'default'。
 */
export interface RunWorkerTickOptions {
  batchSize?: number;
  budgetMs?: number;
  lockTimeoutMs?: number;
  queue?: string;
}

/**
 * Worker tick 执行结果。
 * @property workerId - worker ID。
 * @property recovered - 恢复的卡住任务数。
 * @property claimed - 声称的任务数。
 * @property succeeded - 成功的任务数。
 * @property retried - 需要重试的任务数。
 * @property deadLettered - 进入死信队列的任务数。
 * @property unknownType - 未知类型任务数。
 * @property durationMs - Tick 执行耗时（毫秒）。
 */
export interface RunWorkerTickResult {
  workerId: string;
  recovered: number;
  claimed: number;
  succeeded: number;
  retried: number;
  deadLettered: number;
  unknownType: number;
  durationMs: number;
}

/**
 * 声称的任务行。
 * @property id - 任务 ID。
 * @property type - 任务类型。
 * @property payload - 任务负载。
 * @property attempt - 当前尝试次数。
 * @property maxAttempts - 最大尝试次数。
 * @property runId - 幂等键。
 */
interface ClaimedRow {
  id: string;
  type: string;
  payload: unknown;
  attempt: number;
  maxAttempts: number;
  runId: string | null;
}

export async function runWorkerTick(
  workerId: string,
  opts: RunWorkerTickOptions = {},
): Promise<RunWorkerTickResult> {
  const start = Date.now();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const budgetMs = opts.budgetMs ?? DEFAULT_TICK_BUDGET_MS;
  const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const queue = opts.queue ?? 'default';

  const recovered = await recoverStuckJobs(lockTimeoutMs);

  let claimed = 0;
  let succeeded = 0;
  let retried = 0;
  let deadLettered = 0;
  let unknownType = 0;

  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed + CLAIM_TAIL_GUARD_MS >= budgetMs) break;

    const rows = await claimNext(workerId, batchSize, queue);
    if (rows.length === 0) break;
    claimed += rows.length;

    for (const row of rows) {
      const outcome = await runOne(row, workerId);
      switch (outcome) {
        case 'succeeded':
          succeeded++;
          break;
        case 'retry':
          retried++;
          break;
        case 'dead-letter':
          deadLettered++;
          break;
        case 'unknown-type':
          unknownType++;
          break;
      }
    }
  }

  const durationMs = Date.now() - start;
  jobMetrics().onTickComplete(durationMs, claimed);
  logger.info(
    {
      workerId,
      recovered,
      claimed,
      succeeded,
      retried,
      deadLettered,
      unknownType,
      durationMs,
    },
    'jobs-tick-complete',
  );
  return {
    workerId,
    recovered,
    claimed,
    succeeded,
    retried,
    deadLettered,
    unknownType,
    durationMs,
  };
}

/**
 * 恢复卡住的任务（超时的 RUNNING 任务）。
 * @param lockTimeoutMs - 锁定超时时间。
 * @returns 恢复的任务数。
 */
async function recoverStuckJobs(lockTimeoutMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - lockTimeoutMs);
  const result = await prisma.backgroundJob.updateMany({
    where: { status: 'RUNNING', lockedAt: { lt: cutoff } },
    data: { status: 'PENDING', lockedBy: null, lockedAt: null },
  });
  if (result.count > 0) {
    logger.warn({ count: result.count, lockTimeoutMs }, 'jobs-stuck-recovered');
  }
  return result.count;
}

/**
 * 声称算法 —— `FOR UPDATE SKIP LOCKED` 是这条路径多 worker 安全的钢底。
 * 内层 SELECT 在 (status, queue, priority, nextAttemptAt) 索引上扫，hit 的行
 * 上行锁，被别的 worker 持锁的会被 SKIP；外层 UPDATE 把抢到的翻 RUNNING 一次性返回。
 *
 * `attempt = attempt + 1` 在 claim 时就 bump —— 这意味着「成功 / 失败」都是基于
 * 当前次（包含本次）的 attempt 计数，与 retry.ts 的 `attempt >= maxAttempts` 判断一致。
 * @param workerId - worker ID。
 * @param batchSize - 批次大小。
 * @param queue - 队列名。
 * @returns 声称的任务行列表。
 */
async function claimNext(
  workerId: string,
  batchSize: number,
  queue: string,
): Promise<ClaimedRow[]> {
  return prisma.$queryRaw<ClaimedRow[]>`
    UPDATE "BackgroundJob"
    SET "status" = 'RUNNING'::"BackgroundJobStatus",
        "lockedBy" = ${workerId},
        "lockedAt" = NOW(),
        "startedAt" = COALESCE("startedAt", NOW()),
        "attempt" = "BackgroundJob"."attempt" + 1
    WHERE "id" IN (
      SELECT "id" FROM "BackgroundJob"
      WHERE "status" = 'PENDING'
        AND "queue" = ${queue}
        AND "nextAttemptAt" <= NOW()
      ORDER BY "priority" DESC, "nextAttemptAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "type", "payload", "attempt", "maxAttempts", "runId"
  `;
}

/**
 * 任务执行结果类型。
 */
type RunOutcome = 'succeeded' | 'retry' | 'dead-letter' | 'unknown-type';

/**
 * 执行单个任务。
 * @param row - 待执行的任务行。
 * @param workerId - worker ID。
 * @returns 执行结果。
 */
async function runOne(row: ClaimedRow, workerId: string): Promise<RunOutcome> {
  const def = getJob(row.type);
  if (!def) {
    // Unknown type —— 通常是 schema drift（rolled-back worker 跑到了未来版本 enqueue 的行）。
    // 直接 DEAD_LETTER，admin 可在 `/admin/jobs` 看到 lastError 决定 retry / cancel。
    const deleteAt = new Date(Date.now() + 7 * MS_PER_DAY);
    await prisma.backgroundJob.update({
      where: { id: row.id },
      data: {
        status: 'DEAD_LETTER',
        lastError: `unknown-job-type:${row.type}`,
        completedAt: new Date(),
        lockedBy: null,
        lockedAt: null,
        deleteAt,
      },
    });
    jobMetrics().onDeadLetter(row.type);
    logger.error({ jobId: row.id, type: row.type, workerId }, 'job-unknown-type-dead-letter');
    return 'unknown-type';
  }

  const start = Date.now();
  try {
    const validated = def.payloadSchema.parse(row.payload);
    const result = await withJobTransaction(row.type, row.id, row.attempt, () =>
      runWithTimeout(
        def.run({
          payload: validated,
          attempt: row.attempt,
          jobId: row.id,
          workerId,
          logger: logger.child({ jobId: row.id, jobType: row.type }),
        }),
        def.timeoutMs,
        `job-timeout:${row.type}:${def.timeoutMs}ms`,
      ),
    );

    const durationMs = Date.now() - start;
    const deleteAt = new Date(Date.now() + def.retentionDays * MS_PER_DAY);
    await prisma.backgroundJob.update({
      where: { id: row.id },
      data: {
        status: 'SUCCEEDED',
        result: serializeResult(result),
        completedAt: new Date(),
        lockedBy: null,
        lockedAt: null,
        deleteAt,
      },
    });
    jobMetrics().onSuccess(row.type, durationMs);
    return 'succeeded';
  } catch (err) {
    const durationMs = Date.now() - start;
    const errMsg = errorToString(err).slice(0, ERROR_TRUNCATE_BYTES);
    const delayMs = nextRetryDelayMs(row.attempt, row.maxAttempts, def.retry);

    if (delayMs === null) {
      const deleteAt = new Date(Date.now() + def.retentionDays * MS_PER_DAY);
      await prisma.backgroundJob.update({
        where: { id: row.id },
        data: {
          status: 'DEAD_LETTER',
          lastError: errMsg,
          completedAt: new Date(),
          lockedBy: null,
          lockedAt: null,
          deleteAt,
        },
      });
      jobMetrics().onFailure(row.type, durationMs, false);
      jobMetrics().onDeadLetter(row.type);
      logger.error(
        { jobId: row.id, type: row.type, attempt: row.attempt, durationMs, err: errMsg },
        'job-dead-letter',
      );
      return 'dead-letter';
    }

    await prisma.backgroundJob.update({
      where: { id: row.id },
      data: {
        status: 'PENDING',
        lastError: errMsg,
        nextAttemptAt: new Date(Date.now() + delayMs),
        lockedBy: null,
        lockedAt: null,
      },
    });
    jobMetrics().onFailure(row.type, durationMs, true);
    logger.warn(
      { jobId: row.id, type: row.type, attempt: row.attempt, delayMs, err: errMsg },
      'job-retry-scheduled',
    );
    return 'retry';
  }
}

/**
 * 用超时时间运行 Promise。
 * @param p - 要运行的 Promise。
 * @param timeoutMs - 超时时间（毫秒）。
 * @param msg - 超时错误消息。
 * @returns Promise 执行结果。
 * @throws 如果 Promise 超时或抛出异常。
 */
async function runWithTimeout<T>(p: Promise<T>, timeoutMs: number, msg: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), timeoutMs);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 将任务结果序列化为 Prisma JSON 值。
 * @param result - 任务执行结果。
 * @returns 序列化的值。
 */
function serializeResult(result: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (result === null || result === undefined) return Prisma.JsonNull;
  return result as Prisma.InputJsonValue;
}

/**
 * 将错误对象转换为字符串。
 * @param err - 错误对象。
 * @returns 错误字符串表示。
 */
function errorToString(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ? `${err.name}: ${err.message}\n${err.stack}` : `${err.name}: ${err.message}`;
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
