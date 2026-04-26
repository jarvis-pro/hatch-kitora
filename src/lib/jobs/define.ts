/**
 * RFC 0008 §4.2 / §4.3 — `defineJob` / `defineSchedule` API。
 *
 * 调用方在 `src/lib/jobs/jobs/<type>.ts` 文件里声明一次：
 *
 * ```ts
 * import { z } from 'zod';
 * import { defineJob } from '@/lib/jobs/define';
 *
 * export const emailSendJob = defineJob({
 *   type: 'email.send',
 *   payloadSchema: z.object({ to: z.string().email(), ... }),
 *   maxAttempts: 5,
 *   retentionDays: 7,
 *   retry: 'exponential',
 *   async run({ payload, attempt, jobId, logger }) {
 *     await sendEmail(payload);
 *     return null;
 *   },
 * });
 * ```
 *
 * import 该文件就完成注册（副作用是 `registerJob(...)`）。`scripts/run-jobs.ts`
 * 在 PR-2 通过 `import './bootstrap-jobs'` 触发所有定义文件加载。
 *
 * `defineJob` 返回的对象本身在 PR-1 没有「对外可调」语义 — 调用方不必持有；
 * PR-3 接业务时可以选择 `await emailSendJob.enqueue(payload)` 这种 typed
 * helper（PR-3 决定是否在 JobDefinition 上挂 enqueue 方法），目前 v1 让大家
 * 走通用 `enqueueJob(type, payload)` 入口即可。
 *
 * 类型安全说明（v1 妥协）：`enqueueJob(type, payload)` 通用入口在 v1 类型签名
 * 是 `(type: string, payload: unknown)`，靠运行时 zod 校验把关；PR-3 在接业务时
 * 通过 module augmentation 加 typed overload，让 `enqueueJob('email.send', ...)`
 * 在 TS 编译期就能拒错误 payload（RFC 0008 §2「调用方零样板」+「类型安全到 enqueue 边界」）。
 */

import type { z } from 'zod';

import {
  registerJob,
  registerSchedule,
  type JobContext,
  type JobDefinition,
  type ScheduleDefinition,
} from './registry';
import type { RetryStrategy } from './retry';

export interface DefineJobOptions<TPayload, TResult> {
  type: string;
  payloadSchema: z.ZodType<TPayload>;
  /** 默认 5；超过后翻 DEAD_LETTER。建议 ≤ 8（与 webhook 退避表深度一致）。 */
  maxAttempts?: number;
  /** 终态行多少天后被 prune job 删掉。默认 7。 */
  retentionDays?: number;
  /** 重试策略；默认 `'exponential'`。 */
  retry?: RetryStrategy;
  /** v1 worker 永远只跑 `'default'`（RFC 0008 §9 评审决策）；保留此字段供未来分队列。 */
  queue?: string;
  /** 单次 run handler 超时（毫秒）；默认 10s（< Vercel Hobby 10s function timeout 的 8s 安全档）。 */
  timeoutMs?: number;
  run: (ctx: JobContext<TPayload>) => Promise<TResult>;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_QUEUE = 'default';

export function defineJob<TPayload, TResult = unknown>(
  opts: DefineJobOptions<TPayload, TResult>,
): JobDefinition<TPayload, TResult> {
  const def: JobDefinition<TPayload, TResult> = {
    type: opts.type,
    payloadSchema: opts.payloadSchema,
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    retentionDays: opts.retentionDays ?? DEFAULT_RETENTION_DAYS,
    retry: opts.retry ?? 'exponential',
    queue: opts.queue ?? DEFAULT_QUEUE,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    run: opts.run,
  };
  registerJob(def);
  return def;
}

export interface DefineScheduleOptions {
  /** 唯一 schedule 名字 — 同时是 runId 前缀（`schedule:<name>:<unixMinute>`）。 */
  name: string;
  /** 5 段或 6 段 cron 字符串；PR-2 的 `fireSchedules` 解析此值。 */
  cron: string;
  /** 触发时投递的 job type；`defineJob` 必须先注册过此 type。 */
  jobType: string;
  /** 固定 payload — schedule 没有「调用方动态参数」概念。默认 `{}`。 */
  payload?: unknown;
}

export function defineSchedule(opts: DefineScheduleOptions): ScheduleDefinition {
  const def: ScheduleDefinition = {
    name: opts.name,
    cron: opts.cron,
    jobType: opts.jobType,
    payload: opts.payload ?? {},
  };
  registerSchedule(def);
  return def;
}
