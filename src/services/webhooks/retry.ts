/**
 * RFC 0003 §2.4 — 指数退避调度。
 *
 * 纯助手，可从 cron + e2e 测试导入。这里 `attempt` 是
 * *已完成*尝试的计数（所以 `attempt = 0` 意味着"从未尝试过，立即调度"；
 * `attempt = 1` 意味着"刚失败一次，调度下一次"）。
 *
 *   attempt | 下一次尝试之前的延迟
 *   --------|-----------------------
 *      0    | 0           (立即)
 *      1    | 30秒
 *      2    | 2分钟
 *      3    | 10分钟
 *      4    | 1小时
 *      5    | 6小时
 *      6    | 12小时
 *      7    | 24小时
 *     ≥ 8   | null  ⇒ DEAD_LETTER
 *
 * 返回 `null` 意味着"停止重试"——调用者翻转状态为
 * DEAD_LETTER 而不是写入未来的 `nextAttemptAt`。
 */

export const MAX_ATTEMPTS = 8;

const SCHEDULE_SECONDS: ReadonlyArray<number> = [
  0, // attempt 0 → 立即交付
  30,
  2 * 60,
  10 * 60,
  60 * 60,
  6 * 60 * 60,
  12 * 60 * 60,
  24 * 60 * 60,
];

export function nextRetryDelayMs(attempt: number): number | null {
  if (attempt >= MAX_ATTEMPTS) return null;
  const seconds = SCHEDULE_SECONDS[attempt] ?? null;
  return seconds === null ? null : seconds * 1000;
}

/**
 * 决定 HTTP 响应是意味着"放弃"(DEAD_LETTER) 或"稍后重试"(RETRYING)。
 * 4xx（除 408 / 429 外）是永久的——接收者拒绝请求的形状，
 * 重试不会有帮助。其他一切（5xx、408 超时、429 速率限制、网络错误）是
 * 瞬间的。
 */
export function isPermanentFailure(httpStatus: number): boolean {
  if (httpStatus < 400 || httpStatus >= 500) return false;
  if (httpStatus === 408 || httpStatus === 429) return false;
  return true;
}
