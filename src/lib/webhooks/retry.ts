/**
 * RFC 0003 §2.4 — exponential backoff schedule.
 *
 * Pure helper, importable from the cron + e2e tests. `attempt` here is the
 * count of *completed* attempts (so `attempt = 0` means "never tried, schedule
 * immediately"; `attempt = 1` means "just failed once, schedule next").
 *
 *   attempt | delay before next try
 *   --------|-----------------------
 *      0    | 0           (immediately)
 *      1    | 30s
 *      2    | 2min
 *      3    | 10min
 *      4    | 1h
 *      5    | 6h
 *      6    | 12h
 *      7    | 24h
 *     ≥ 8   | null  ⇒ DEAD_LETTER
 *
 * Returning `null` means "stop retrying" — the caller flips status to
 * DEAD_LETTER instead of writing a future `nextAttemptAt`.
 */

export const MAX_ATTEMPTS = 8;

const SCHEDULE_SECONDS: ReadonlyArray<number> = [
  0, // attempt 0 → deliver now
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
 * Decide whether an HTTP response means "give up" (DEAD_LETTER) or "try
 * again later" (RETRYING). 4xx (excluding 408 / 429) is permanent — the
 * receiver is rejecting the shape of the request, retrying won't help.
 * Everything else (5xx, 408 timeout, 429 rate limit, network errors) is
 * transient.
 */
export function isPermanentFailure(httpStatus: number): boolean {
  if (httpStatus < 400 || httpStatus >= 500) return false;
  if (httpStatus === 408 || httpStatus === 429) return false;
  return true;
}
