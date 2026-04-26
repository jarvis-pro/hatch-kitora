/**
 * RFC 0008 §4.8 / §5.4 — Background jobs 可观测性钩子。
 *
 * v1 是「占位 + logger」的双轨：
 *
 *   - logger 直接调（pino structured logs，已经在 RFC 0006 metrics 钩子里
 *     被吸进 SLS / CloudWatch）；
 *   - metrics hook 是 noop 默认实现，PR-4 接 RFC 0006 metrics 适配器后通过
 *     `setMetricsHook(...)` 注入真实 counter / histogram；
 *   - Sentry transaction wrap：v1 暂用 thin wrapper，PR-4 改为 `Sentry.startSpan`
 *     的真实 op=job 集成。这一步保留接口、不引爆改动。
 *
 * 注意：本模块**不**直接 import `@sentry/nextjs` — Sentry transitive 拉进
 * Next.js runtime 在 tsx CLI 入口（PR-2 的 scripts/run-jobs.ts）会触发
 * 「Cannot find module 'next/dist/...'」类错误。PR-4 接入时再走 dynamic import 解决。
 */

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

/**
 * 给单 job 执行加一层 Sentry transaction。v1 是 thin wrapper（仅 logger
 * breadcrumb + 透传 promise），PR-4 替换为 `Sentry.startSpan({ op: 'job',
 * name: type, attributes: { 'job.id': jobId } }, fn)`。
 *
 * 任何错误透传给上层 — 本函数不吞错（让 runner.ts 决定 retry / DLQ）。
 */
export async function withJobTransaction<T>(
  type: string,
  jobId: string,
  attempt: number,
  fn: () => Promise<T>,
): Promise<T> {
  logger.debug({ jobType: type, jobId, attempt }, 'job-transaction-start');
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
