/**
 * RFC 0008 §4.1 — Job 注册表（模块级 singleton）。
 *
 * `defineJob({ type: 'email.send', ... })` 在 import 时把定义塞进这个 Map；
 * worker 拿到一行 BackgroundJob 后按 `type` 反查出 handler / schema / 重试策略。
 *
 * Schedule 注册表同理（v1 不建 `Schedule` 表，纯代码 — RFC 0008 §3.3 / §9 评审决策）。
 *
 * 单例选择 `globalThis` 是为了：
 *   - dev mode HMR 不丢 registry；
 *   - vitest forks pool 每个 file 独立 fork（process）也独立，不互污染；
 *   - tsx 多次 require / import 进同一进程时只注册一次。
 *
 * 重复 register 同一 type 抛错 — 这是代码 bug 信号（两份定义争同一 type），
 * 不是运行时可恢复的状态；让它在启动时就炸出来更安全。
 */

import type { z } from 'zod';

import type { Logger } from '@/lib/logger';

import type { RetryStrategy } from './retry';

/**
 * Job 执行上下文 — handler 收到的唯一参数。
 */
export interface JobContext<TPayload = unknown> {
  payload: TPayload;
  /** 当前是第几次尝试（已包含本次）；首跑 = 1。 */
  attempt: number;
  jobId: string;
  workerId: string;
  /** 已绑定 `{ jobId, jobType }` 的 child logger。 */
  logger: Logger;
}

export interface JobDefinition<TPayload = unknown, TResult = unknown> {
  type: string;
  payloadSchema: z.ZodType<TPayload>;
  maxAttempts: number;
  /** 终态行多少天后被 prune job 删掉。 */
  retentionDays: number;
  retry: RetryStrategy;
  queue: string;
  timeoutMs: number;
  run: (ctx: JobContext<TPayload>) => Promise<TResult>;
}

export interface ScheduleDefinition {
  /** 唯一的 schedule 名字，进 runId 形如 `schedule:<name>:<unixMinute>`。 */
  name: string;
  cron: string;
  /** schedule 触发后投递的 job type；必须能在 JobRegistry 里找到。 */
  jobType: string;
  /** schedule 触发投递的固定 payload — schedule 本身没有「调用方动态参数」。 */
  payload: unknown;
}

/**
 * Registry 内部把所有 JobDefinition 擦除到 `<unknown, unknown>` —— Map 是异构容器，
 * 必然要在「存」与「取」的边界丢具体泛型。runner.ts 通过 `def.payloadSchema.parse(...)`
 * 在 use site 重新拿回类型安全（zod 把 unknown 收窄回 TPayload）。
 */
type AnyJobDefinition = JobDefinition<unknown, unknown>;

interface JobRegistryShape {
  jobs: Map<string, AnyJobDefinition>;
  schedules: Map<string, ScheduleDefinition>;
}

const REGISTRY_KEY = Symbol.for('kitora.jobs.registry.v1');

function getRegistry(): JobRegistryShape {
  const g = globalThis as unknown as Record<symbol, JobRegistryShape | undefined>;
  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = {
      jobs: new Map(),
      schedules: new Map(),
    };
  }
  return g[REGISTRY_KEY]!;
}

export function registerJob<TPayload, TResult>(def: JobDefinition<TPayload, TResult>): void {
  const reg = getRegistry();
  if (reg.jobs.has(def.type)) {
    throw new Error(`registerJob: duplicate job type "${def.type}" — defineJob() called twice`);
  }
  // JobDefinition 的 TPayload 在 `payloadSchema: ZodType<TPayload>` 与 `run(ctx:
  // JobContext<TPayload>)` 双向出现 → invariant，没有协变路径直接赋值。在「存进
  // 异构 Map」的边界做单次 `as unknown as` 擦除是合理的工程妥协；取出时仍是
  // `AnyJobDefinition`，由 zod runtime 收窄回具体类型。
  reg.jobs.set(def.type, def as unknown as AnyJobDefinition);
}

export function getJob(type: string): AnyJobDefinition | undefined {
  return getRegistry().jobs.get(type);
}

export function listJobTypes(): string[] {
  return Array.from(getRegistry().jobs.keys()).sort();
}

export function registerSchedule(def: ScheduleDefinition): void {
  const reg = getRegistry();
  if (reg.schedules.has(def.name)) {
    throw new Error(
      `registerSchedule: duplicate schedule name "${def.name}" — defineSchedule() called twice`,
    );
  }
  reg.schedules.set(def.name, def);
}

export function listSchedules(): ScheduleDefinition[] {
  return Array.from(getRegistry().schedules.values());
}

/**
 * Test-only — 仅 vitest 单测内重置 registry。生产 / dev 一律不调。
 * 命名带 `__` 前缀让 grep / lint 容易识别。
 */
export function __resetRegistry(): void {
  const reg = getRegistry();
  reg.jobs.clear();
  reg.schedules.clear();
}
