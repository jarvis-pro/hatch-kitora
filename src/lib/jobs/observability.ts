/**
 * RFC 0008 §4.8 / §5.4 / PR-4 — Background jobs 可观测性钩子。
 *
 * 三轨：
 *
 *   1. **logger** —— pino structured logs，已经在 RFC 0006 metrics 钩子里被吸进
 *      SLS / CloudWatch；本文件直接调。
 *
 *   2. **metrics hook** —— `JobMetricsHook` 接口 + `noop` 默认实现；生产由 PR-4
 *      RFC 0006 metrics 适配器通过 `setMetricsHook(...)` 注入真实 counter /
 *      histogram。计数器命名见 `JobMetricsHook` 注释。
 *
 *   3. **Sentry transaction** —— PR-4 起用真实 `Sentry.startSpan({ op: 'job', name,
 *      attributes: { 'job.id', 'job.attempt' } })` 包每个 job 执行；失败时
 *      `Sentry.captureException(err, { tags: { jobType }, extra: { jobId, attempt } })`。
 *      未配 `NEXT_PUBLIC_SENTRY_DSN` 时 Sentry SDK 自动 noop（v8 设计），无需额外 guard。
 *
 * ## Sentry import 策略
 *
 * **不**在文件顶部静态 import `@sentry/nextjs` —— 该包 server entry 透传
 * `next/dist/...` 内部模块，CLI 入口（`scripts/run-jobs.ts` 走 tsx）下没有 Next.js
 * runtime 时会冒「Cannot find module」。改走 dynamic import + try/catch fallback：
 *
 *   - 首次调用 `getSentry()` 异步加载，结果（成功的 SDK 模块或 null）缓存进
 *     `sentryPromise`，后续调用零开销复用；
 *   - 加载失败时 fallback 到「仅 logger breadcrumbs」的透传路径，worker 行为完全
 *     与 v1 一致 —— 这条路在 vitest unit test、tsx CLI、e2e 三个环境都是常态。
 */

import type * as SentryNextjs from '@sentry/nextjs';

import { logger } from '@/lib/logger';

/**
 * Metrics 钩子 — RFC 0006 PR-4 metrics 适配器在生产环境注入的实现。
 *
 * counter / gauge 命名（在 dashboards / Sentry / Datadog 中显示）：
 *   - `jobs.success.total{type=}`
 *   - `jobs.failure.total{type=,willRetry=}`
 *   - `jobs.dlq.total{type=}`
 *   - `jobs.duration.ms{type=}` (histogram)
 *   - `jobs.tick.duration.ms`
 *   - `jobs.tick.claimed.count`
 *   - `jobs.queue.lag.seconds` (gauge — 最老 PENDING 行的 createdAt 距 now)
 */
export interface JobMetricsHook {
  onSuccess(type: string, durationMs: number): void;
  onFailure(type: string, durationMs: number, willRetry: boolean): void;
  onDeadLetter(type: string): void;
  onTickComplete(durationMs: number, claimed: number): void;
}

const noopMetrics: JobMetricsHook = {
  onSuccess() {},
  onFailure() {},
  onDeadLetter() {},
  onTickComplete() {},
};

let activeMetrics: JobMetricsHook = noopMetrics;

export function setMetricsHook(hook: JobMetricsHook): void {
  activeMetrics = hook;
}

export function jobMetrics(): JobMetricsHook {
  return activeMetrics;
}

// ── Sentry dynamic import ────────────────────────────────────────────

type SentryModule = typeof SentryNextjs;
let sentryPromise: Promise<SentryModule | null> | null = null;

function loadSentry(): Promise<SentryModule | null> {
  if (sentryPromise === null) {
    sentryPromise = import('@sentry/nextjs').catch((err) => {
      // 一次性 warn，后续调用复用缓存的 null（Promise.resolve(null) 走 fast path）。
      logger.warn({ err }, 'sentry-import-failed-fallback-noop');
      return null;
    });
  }
  return sentryPromise;
}

/**
 * 给单 job 执行加一层 Sentry span。任何错误透传给上层（runner.ts 决定 retry / DLQ）；
 * 错误同时报给 Sentry 带上 `jobType` tag + `jobId` / `attempt` extra，方便 dashboard
 * 按 type 切片。
 *
 * 不需要 caller 关心 Sentry 是否可用 —— 加载失败 / SDK 未初始化时函数行为退化为
 * 「logger debug + 透传」，业务路径不变。
 */
export async function withJobTransaction<T>(
  type: string,
  jobId: string,
  attempt: number,
  fn: () => Promise<T>,
): Promise<T> {
  logger.debug({ jobType: type, jobId, attempt }, 'job-transaction-start');

  const Sentry = await loadSentry();
  // 两道兜底：
  //   1. import 直接抛 → loadSentry 已 catch 返回 null（CLI 入口下 next/dist/* 缺失）。
  //   2. import 没抛但模块「形状不对」—— Playwright e2e 的 tsx 进程能加载
  //      `@sentry/nextjs` 但 server entry 的某些 transitive bind 失败，
  //      `Sentry.startSpan` / `Sentry.captureException` 落不下来。命中时如果还硬调，
  //      就把 `TypeError: Sentry.startSpan is not a function` 当成 handler 失败
  //      传给 runner，被 retry / DLQ 误判（jobs.spec.ts e2e 实测过这条路径）。
  //   两条都退化到「仅 logger breadcrumbs」的透传路径。
  if (!Sentry || typeof Sentry.startSpan !== 'function') {
    return runWithLogger(type, jobId, attempt, fn);
  }

  return Sentry.startSpan(
    {
      op: 'job',
      name: type,
      attributes: {
        'job.id': jobId,
        'job.attempt': attempt,
      },
    },
    async () => {
      try {
        const out = await fn();
        logger.debug({ jobType: type, jobId, attempt }, 'job-transaction-success');
        return out;
      } catch (err) {
        logger.debug({ jobType: type, jobId, attempt, err }, 'job-transaction-error');
        // tags 用于在 Sentry dashboard 按 type 过滤；extra 出现在 issue detail 页。
        Sentry.captureException(err, {
          tags: { jobType: type },
          extra: { jobId, attempt },
        });
        throw err;
      }
    },
  );
}

async function runWithLogger<T>(
  type: string,
  jobId: string,
  attempt: number,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const out = await fn();
    logger.debug({ jobType: type, jobId, attempt }, 'job-transaction-success');
    return out;
  } catch (err) {
    logger.debug({ jobType: type, jobId, attempt, err }, 'job-transaction-error');
    throw err;
  }
}

/**
 * Test-only — 单测用以重置 metrics hook 回 noop。
 */
export function __resetMetrics(): void {
  activeMetrics = noopMetrics;
}

/**
 * Test-only — 单测用以重置 Sentry 加载缓存（让下一次调用重新 import）。
 */
export function __resetSentryCache(): void {
  sentryPromise = null;
}
