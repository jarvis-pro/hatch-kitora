/**
 * RFC 0008 §4.4 / §6 PR-1 — 重试策略边界测试。
 *
 * 纯函数，无 DB / 无 mock；覆盖三策略 × 边界（attempt = 0 / 表中 / 表尾 / 越界 /
 * ≥ maxAttempts）确保 runner.ts 翻 DEAD_LETTER 的时机准确。
 */

import { describe, expect, it } from 'vitest';

import { nextRetryDelayMs } from './retry';

describe('nextRetryDelayMs (exponential)', () => {
  it.each([
    [0, 0],
    [1, 30 * 1000],
    [2, 2 * 60 * 1000],
    [3, 10 * 60 * 1000],
    [4, 60 * 60 * 1000],
    [5, 6 * 60 * 60 * 1000],
    [6, 12 * 60 * 60 * 1000],
    [7, 24 * 60 * 60 * 1000],
  ])('attempt=%i 返回 %ims（与 webhook retry 表对齐）', (attempt, expected) => {
    expect(nextRetryDelayMs(attempt, 8, 'exponential')).toBe(expected);
  });

  it('attempt >= maxAttempts → null（DEAD_LETTER 信号）', () => {
    expect(nextRetryDelayMs(8, 8, 'exponential')).toBeNull();
    expect(nextRetryDelayMs(10, 5, 'exponential')).toBeNull();
    expect(nextRetryDelayMs(5, 5, 'exponential')).toBeNull();
  });

  it('attempt 超出 8 阶表但 < maxAttempts → 复用最后一档（24h）', () => {
    expect(nextRetryDelayMs(8, 10, 'exponential')).toBe(24 * 60 * 60 * 1000);
    expect(nextRetryDelayMs(9, 10, 'exponential')).toBe(24 * 60 * 60 * 1000);
  });

  it('默认策略 = exponential（不传第三参数）', () => {
    expect(nextRetryDelayMs(1, 8)).toBe(30 * 1000);
  });
});

describe('nextRetryDelayMs (fixed)', () => {
  it('每次失败固定 60 秒', () => {
    expect(nextRetryDelayMs(0, 5, 'fixed')).toBe(60 * 1000);
    expect(nextRetryDelayMs(3, 5, 'fixed')).toBe(60 * 1000);
    expect(nextRetryDelayMs(4, 5, 'fixed')).toBe(60 * 1000);
  });

  it('attempt >= maxAttempts → null', () => {
    expect(nextRetryDelayMs(5, 5, 'fixed')).toBeNull();
    expect(nextRetryDelayMs(100, 5, 'fixed')).toBeNull();
  });
});

describe('nextRetryDelayMs (custom)', () => {
  const strategy = { strategy: 'custom' as const, delays: [1000, 2000, 3000] };

  it('按 delays 数组取索引', () => {
    expect(nextRetryDelayMs(0, 5, strategy)).toBe(1000);
    expect(nextRetryDelayMs(1, 5, strategy)).toBe(2000);
    expect(nextRetryDelayMs(2, 5, strategy)).toBe(3000);
  });

  it('attempt 越界 delays 数组 → null', () => {
    expect(nextRetryDelayMs(3, 5, strategy)).toBeNull();
    expect(nextRetryDelayMs(10, 5, strategy)).toBeNull();
  });

  it('attempt >= maxAttempts 比 delays 长度先生效', () => {
    expect(
      nextRetryDelayMs(3, 3, { strategy: 'custom', delays: [1000, 2000, 3000, 4000] }),
    ).toBeNull();
  });
});
