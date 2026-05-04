/**
 * RFC 0008 §4.3 / §6 PR-2 — Cron matcher 测试。
 *
 * 覆盖：
 *   - parseCronExpression：5 段必须、边界检查、step / range / list / 错误抛出；
 *   - matchesCron：四种生产 cron + 几个边界（dom/dow OR 合、范围步长）；
 *   - floorToUnixMinute：基本时间换算。
 */

import { describe, expect, it } from 'vitest';

import { floorToUnixMinute, matchesCron, parseCronExpression } from './cron';

describe('parseCronExpression', () => {
  it('5 段简单星号', () => {
    const expr = parseCronExpression('* * * * *');
    expect(expr.minute.size).toBe(60);
    expect(expr.hour.size).toBe(24);
    expect(expr.dom.size).toBe(31);
    expect(expr.month.size).toBe(12);
    expect(expr.dow.size).toBe(7);
  });

  it('具体数字', () => {
    const expr = parseCronExpression('0 3 * * *');
    expect(Array.from(expr.minute)).toEqual([0]);
    expect(Array.from(expr.hour)).toEqual([3]);
  });

  it('范围 N-M', () => {
    const expr = parseCronExpression('1-5 * * * *');
    expect(Array.from(expr.minute).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('步长 *\/N', () => {
    const expr = parseCronExpression('*/15 * * * *');
    expect(Array.from(expr.minute).sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it('列表 A,B,C', () => {
    const expr = parseCronExpression('15,30,45 * * * *');
    expect(Array.from(expr.minute).sort((a, b) => a - b)).toEqual([15, 30, 45]);
  });

  it('范围 + 步长 N-M/K', () => {
    const expr = parseCronExpression('0-30/10 * * * *');
    expect(Array.from(expr.minute).sort((a, b) => a - b)).toEqual([0, 10, 20, 30]);
  });

  it('段数错误抛错', () => {
    expect(() => parseCronExpression('* * * *')).toThrowError(/expected 5 fields/);
    expect(() => parseCronExpression('* * * * * *')).toThrowError(/expected 5 fields/);
  });

  it('越界抛错', () => {
    expect(() => parseCronExpression('60 * * * *')).toThrowError(/out of bounds/);
    expect(() => parseCronExpression('* 24 * * *')).toThrowError(/out of bounds/);
    expect(() => parseCronExpression('* * 32 * *')).toThrowError(/out of bounds/);
    expect(() => parseCronExpression('* * * 0 *')).toThrowError(/out of bounds/);
  });

  it('非整数抛错', () => {
    expect(() => parseCronExpression('abc * * * *')).toThrowError(/not an integer/);
  });

  it('范围 start > end 抛错', () => {
    expect(() => parseCronExpression('5-1 * * * *')).toThrowError(/start > end/);
  });
});

describe('matchesCron', () => {
  // 2026-04-26 03:00:00 UTC = 周日（dow=0）
  const sundayUtc0300 = new Date(Date.UTC(2026, 3, 26, 3, 0, 0));
  // 2026-04-27 11:30:00 UTC = 周一（dow=1）
  const mondayUtc1130 = new Date(Date.UTC(2026, 3, 27, 11, 30, 0));

  it('* * * * * 匹配任何时间', () => {
    expect(matchesCron('* * * * *', sundayUtc0300)).toBe(true);
    expect(matchesCron('* * * * *', mondayUtc1130)).toBe(true);
  });

  it('0 3 * * * 仅匹配 UTC 03:00（deletion-cron 用）', () => {
    expect(matchesCron('0 3 * * *', sundayUtc0300)).toBe(true);
    expect(matchesCron('0 3 * * *', mondayUtc1130)).toBe(false);
  });

  it('0 * * * * 每小时第 0 分钟（token-cleanup 用）', () => {
    expect(matchesCron('0 * * * *', sundayUtc0300)).toBe(true);
    expect(matchesCron('0 * * * *', mondayUtc1130)).toBe(false);
  });

  it('0 4 * * * 仅匹配 UTC 04:00（job-prune 用）', () => {
    expect(matchesCron('0 4 * * *', new Date(Date.UTC(2026, 3, 26, 4, 0, 0)))).toBe(true);
    expect(matchesCron('0 4 * * *', sundayUtc0300)).toBe(false);
  });

  it('*\/15 * * * * 每 15 分钟', () => {
    expect(matchesCron('*/15 * * * *', new Date(Date.UTC(2026, 3, 26, 0, 0, 0)))).toBe(true);
    expect(matchesCron('*/15 * * * *', new Date(Date.UTC(2026, 3, 26, 0, 15, 0)))).toBe(true);
    expect(matchesCron('*/15 * * * *', new Date(Date.UTC(2026, 3, 26, 0, 16, 0)))).toBe(false);
  });

  it('0 0 * * 0 仅周日 00:00', () => {
    expect(matchesCron('0 0 * * 0', new Date(Date.UTC(2026, 3, 26, 0, 0, 0)))).toBe(true); // 周日
    expect(matchesCron('0 0 * * 0', new Date(Date.UTC(2026, 3, 27, 0, 0, 0)))).toBe(false); // 周一
  });

  it('dom + dow 都限定 → OR 合（标准 Vixie cron）', () => {
    // 1 号 OR 周一 触发：2026-04-26（周日 26 号）→ 不匹配；2026-04-27（周一）→ 匹配 dow=1
    expect(matchesCron('0 0 1 * 1', new Date(Date.UTC(2026, 3, 27, 0, 0, 0)))).toBe(true);
    // 2026-04-01（周三）→ 匹配 dom=1
    expect(matchesCron('0 0 1 * 1', new Date(Date.UTC(2026, 3, 1, 0, 0, 0)))).toBe(true);
    // 2026-04-26（周日 26）→ 都不匹配
    expect(matchesCron('0 0 1 * 1', new Date(Date.UTC(2026, 3, 26, 0, 0, 0)))).toBe(false);
  });
});

describe('floorToUnixMinute', () => {
  it('精确分钟边界', () => {
    const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(floorToUnixMinute(d)).toBe(d.getTime() / 60_000);
  });

  it('秒级被丢弃', () => {
    const minuteStart = new Date(Date.UTC(2026, 0, 1, 0, 5, 0));
    const sameMinuteLater = new Date(Date.UTC(2026, 0, 1, 0, 5, 59));
    expect(floorToUnixMinute(minuteStart)).toBe(floorToUnixMinute(sameMinuteLater));
  });

  it('不同分钟 → 不同 unixMinute', () => {
    const a = new Date(Date.UTC(2026, 0, 1, 0, 5, 0));
    const b = new Date(Date.UTC(2026, 0, 1, 0, 6, 0));
    expect(floorToUnixMinute(a) + 1).toBe(floorToUnixMinute(b));
  });
});
