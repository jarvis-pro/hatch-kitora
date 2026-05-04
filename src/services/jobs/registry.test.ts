/**
 * RFC 0008 §4.1 / §6 PR-1 — Registry 行为测试。
 *
 * 验证：
 *   - registerJob / getJob / listJobTypes 基础往返；
 *   - 重复注册同 type 抛错（代码 bug 信号，非运行时可恢复状态）；
 *   - registerSchedule 同上；
 *   - __resetRegistry 清空两个 Map（vitest forks pool 下每个 file 独立 process，
 *     不严格需要 reset，但显式 reset 让测试自洽）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  __resetRegistry,
  getJob,
  type JobDefinition,
  listJobTypes,
  listSchedules,
  registerJob,
  registerSchedule,
} from './registry';

function dummyJob(type: string): JobDefinition<unknown, unknown> {
  return {
    type,
    payloadSchema: z.unknown(),
    maxAttempts: 5,
    retentionDays: 7,
    retry: 'exponential',
    queue: 'default',
    timeoutMs: 8_000,
    run: async () => null,
  };
}

describe('JobRegistry', () => {
  beforeEach(() => __resetRegistry());

  it('registerJob → getJob 返回相同定义引用', () => {
    const def = dummyJob('test.foo');
    registerJob(def);
    expect(getJob('test.foo')).toBe(def);
  });

  it('未注册 type → getJob 返回 undefined', () => {
    expect(getJob('test.never-registered')).toBeUndefined();
  });

  it('重复 register 同 type → 抛 duplicate 错误', () => {
    registerJob(dummyJob('test.dup'));
    expect(() => registerJob(dummyJob('test.dup'))).toThrowError(/duplicate job type "test\.dup"/);
  });

  it('listJobTypes 返回排序后的 type 列表', () => {
    registerJob(dummyJob('test.b'));
    registerJob(dummyJob('test.a'));
    registerJob(dummyJob('test.c'));
    expect(listJobTypes()).toEqual(['test.a', 'test.b', 'test.c']);
  });

  it('__resetRegistry 清空 jobs 与 schedules', () => {
    registerJob(dummyJob('test.x'));
    registerSchedule({ name: 'sched', cron: '* * * * *', jobType: 'test.x', payload: {} });
    expect(listJobTypes()).toHaveLength(1);
    expect(listSchedules()).toHaveLength(1);

    __resetRegistry();

    expect(listJobTypes()).toHaveLength(0);
    expect(listSchedules()).toHaveLength(0);
  });
});

describe('ScheduleRegistry', () => {
  beforeEach(() => __resetRegistry());

  it('registerSchedule + listSchedules 基础往返', () => {
    registerSchedule({ name: 'a', cron: '* * * * *', jobType: 'foo', payload: {} });
    registerSchedule({ name: 'b', cron: '0 * * * *', jobType: 'bar', payload: { x: 1 } });
    const list = listSchedules();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.name).sort()).toEqual(['a', 'b']);
  });

  it('重复 register 同 schedule name → 抛错', () => {
    registerSchedule({ name: 'dup', cron: '* * * * *', jobType: 'x', payload: {} });
    expect(() =>
      registerSchedule({ name: 'dup', cron: '0 * * * *', jobType: 'y', payload: {} }),
    ).toThrowError(/duplicate schedule name "dup"/);
  });
});
