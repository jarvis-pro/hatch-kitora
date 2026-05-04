/**
 * RFC 0008 §4.2 / §6 PR-1 — defineJob / defineSchedule 行为测试。
 *
 * 主测：
 *   - defaults 注入（maxAttempts=5 / retentionDays=7 / retry=exponential /
 *     queue=default / timeoutMs=8000）；
 *   - 显式参数覆盖 defaults；
 *   - 副作用：注册到 registry，getJob 可取；
 *   - 重复 type 抛错（透传 registerJob 的检查）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineJob, defineSchedule } from './define';
import { __resetRegistry, getJob, listSchedules } from './registry';

describe('defineJob', () => {
  beforeEach(() => __resetRegistry());

  it('defaults 注入正确', () => {
    const def = defineJob({
      type: 'test.bare',
      payloadSchema: z.object({}),
      run: async () => null,
    });
    expect(def.maxAttempts).toBe(5);
    expect(def.retentionDays).toBe(7);
    expect(def.retry).toBe('exponential');
    expect(def.queue).toBe('default');
    expect(def.timeoutMs).toBe(8_000);
  });

  it('显式参数覆盖 defaults', () => {
    const def = defineJob({
      type: 'test.custom',
      payloadSchema: z.object({}),
      maxAttempts: 3,
      retentionDays: 30,
      retry: 'fixed',
      queue: 'high',
      timeoutMs: 15_000,
      run: async () => null,
    });
    expect(def.maxAttempts).toBe(3);
    expect(def.retentionDays).toBe(30);
    expect(def.retry).toBe('fixed');
    expect(def.queue).toBe('high');
    expect(def.timeoutMs).toBe(15_000);
  });

  it('副作用：defineJob 自动注册到 registry', () => {
    const def = defineJob({
      type: 'test.side-effect',
      payloadSchema: z.object({}),
      run: async () => null,
    });
    expect(getJob('test.side-effect')).toBe(def);
  });

  it('重复 defineJob 同 type → 抛错', () => {
    defineJob({ type: 'test.dup', payloadSchema: z.object({}), run: async () => null });
    expect(() =>
      defineJob({ type: 'test.dup', payloadSchema: z.object({}), run: async () => null }),
    ).toThrowError(/duplicate job type "test\.dup"/);
  });

  it('payloadSchema / run 引用透传到 def', () => {
    const schema = z.object({ x: z.number() });
    const run = async () => ({ ok: true });
    const def = defineJob({ type: 'test.passthrough', payloadSchema: schema, run });
    expect(def.payloadSchema).toBe(schema);
    expect(def.run).toBe(run);
  });
});

describe('defineSchedule', () => {
  beforeEach(() => __resetRegistry());

  it('payload 默认 = {}', () => {
    const s = defineSchedule({
      name: 'sched.empty',
      cron: '* * * * *',
      jobType: 'foo',
    });
    expect(s.payload).toEqual({});
  });

  it('显式 payload 透传', () => {
    const s = defineSchedule({
      name: 'sched.with-payload',
      cron: '0 * * * *',
      jobType: 'bar',
      payload: { region: 'GLOBAL' },
    });
    expect(s.payload).toEqual({ region: 'GLOBAL' });
  });

  it('注册到 ScheduleRegistry', () => {
    defineSchedule({ name: 'a', cron: '* * * * *', jobType: 'x' });
    const list = listSchedules();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('a');
    expect(list[0]?.cron).toBe('* * * * *');
  });
});
