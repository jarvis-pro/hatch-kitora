/**
 * RFC 0008 §4 — Background jobs 重试退避策略。
 *
 * 三种策略：
 *
 *   - `'exponential'`（默认）: 与 RFC 0003 webhook 相同的 8 阶曲线
 *     `[0, 30s, 2m, 10m, 1h, 6h, 12h, 24h]`，覆盖到 maxAttempts 后返回 null
 *     ⇒ caller 应翻 DEAD_LETTER。曲线超出表长时复用最后一档（24h），
 *     但 maxAttempts ≤ 8 是建议上限。
 *
 *   - `'fixed'`: 每次失败固定 60 秒后再试。适用于「外部依赖间歇性挂掉、
 *     不必指数回退」的活，例如轻量探针或重要性不高的 sweep。
 *
 *   - `{ strategy: 'custom', delays: [...] }`: 调用方完全自定义曲线，
 *     `delays[attempt]` 是「第 attempt 次完成后等待多少毫秒再试」。
 *     越界返回 null ⇒ DEAD_LETTER。
 *
 * `attempt` 的语义与 webhook retry 一致：表示「已经完成的尝试次数」，
 * 即 attempt = 1 表示「刚失败一次，调度第 2 次重试」；attempt ≥ maxAttempts
 * 时无条件返回 null。
 */

/**
 * 重试策略类型。
 */
export type RetryStrategy =
  | 'exponential'
  | 'fixed'
  | { strategy: 'custom'; delays: readonly number[] };

/**
 * 指数退避延迟（秒）。
 */
const EXPONENTIAL_SECONDS: ReadonlyArray<number> = [
  0, // attempt 0 —— 立即跑（保留与 webhook retry 表一致的 0 索引）
  30,
  2 * 60,
  10 * 60,
  60 * 60,
  6 * 60 * 60,
  12 * 60 * 60,
  24 * 60 * 60,
];

/**
 * 固定延迟时间（毫秒）。
 */
const FIXED_DELAY_MS = 60 * 1000;

/**
 * 计算下一次重试的 delay（毫秒）。返回 null 表示不再重试，caller 应翻 DEAD_LETTER。
 *
 * 重要：本函数纯计算，不读 / 写 DB；caller 拿到返回值后自己写
 * `nextAttemptAt = new Date(Date.now() + delayMs)`。
 * @param attempt - 当前尝试次数。
 * @param maxAttempts - 最大尝试次数。
 * @param strategy - 重试策略；默认 'exponential'。
 * @returns 延迟毫秒数，或 null 如果不应再重试。
 */
export function nextRetryDelayMs(
  attempt: number,
  maxAttempts: number,
  strategy: RetryStrategy = 'exponential',
): number | null {
  if (attempt >= maxAttempts) return null;

  if (strategy === 'exponential') {
    // 取 attempt 索引；超出表长复用最后一档（24h），与原 webhook 表行为对齐。
    const idx = Math.min(attempt, EXPONENTIAL_SECONDS.length - 1);
    const seconds = EXPONENTIAL_SECONDS[idx];
    return seconds === undefined ? null : seconds * 1000;
  }

  if (strategy === 'fixed') {
    return FIXED_DELAY_MS;
  }

  // 自定义策略
  const delay = strategy.delays[attempt];
  return delay === undefined ? null : delay;
}
