/**
 * RFC 0008 §4.3 / §4.5 / §6 PR-2 — fireSchedules 行为测试。
 *
 * mock 掉 ./enqueue，只验证「按 cron 是否调用 enqueueJob，runId 形状」；
 * 不测 prisma 路径（已在 enqueue.test.ts 覆盖）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./enqueue', () => ({
  enqueueJob: vi.fn(),
}));

import { enqueueJob } from './enqueue';

import { __resetRegistry, registerSchedule } from './registry';
import { fireSchedules } from './schedules';
import { floorToUnixMinute } from './cron';

const mockedEnqueue = enqueueJob as unknown as ReturnType<typeof vi.fn>;

describe('fireSchedules', () => {
  beforeEach(() => {
    __resetRegistry();
    vi.clearAllMocks();
  });

  it('cron 不匹配 → 不调 enqueueJob', async () => {
    registerSchedule({
      name: 'every-3am',
      cron: '0 3 * * *',
      jobType: 'fake.job',
      payload: {},
    });
    // 11:30 UTC ≠ 03:00
    const now = new Date(Date.UTC(2026, 3, 27, 11, 30, 0));
    const result = await fireSchedules(now);
    expect(result.matched).toEqual([]);
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it('cron 匹配 → 调 enqueueJob，runId 形如 schedule:<name>:<unixMinute>', async () => {
    registerSchedule({
      name: 'every-min',
      cron: '* * * * *',
      jobType: 'fake.tick',
      payload: { foo: 'bar' },
    });
    mockedEnqueue.mockResolvedValueOnce({ id: 'job-1', deduplicated: false });

    const now = new Date(Date.UTC(2026, 3, 27, 11, 30, 0));
    const result = await fireSchedules(now);

    expect(result.matched).toEqual(['every-min']);
    expect(result.enqueued).toEqual(['every-min']);
    expect(result.deduplicated).toEqual([]);
    expect(result.unixMinute).toBe(floorToUnixMinute(now));

    expect(mockedEnqueue).toHaveBeenCalledOnce();
    expect(mockedEnqueue).toHaveBeenCalledWith(
      'fake.tick',
      { foo: 'bar' },
      {
        runId: `schedule:every-min:${floorToUnixMinute(now)}`,
      },
    );
  });

  it('deduplicated=true 进入 deduplicated 数组（同分钟二次调用）', async () => {
    registerSchedule({ name: 's1', cron: '* * * * *', jobType: 'x', payload: {} });
    mockedEnqueue.mockResolvedValueOnce({ id: 'existing', deduplicated: true });

    const result = await fireSchedules(new Date(Date.UTC(2026, 3, 27, 11, 30, 0)));
    expect(result.deduplicated).toEqual(['s1']);
    expect(result.enqueued).toEqual([]);
  });

  it('多个 schedule：仅匹配的被 enqueue', async () => {
    registerSchedule({ name: 'a', cron: '* * * * *', jobType: 'x', payload: {} });
    registerSchedule({ name: 'b', cron: '0 4 * * *', jobType: 'y', payload: {} }); // 不匹配 11:30
    registerSchedule({ name: 'c', cron: '30 11 * * *', jobType: 'z', payload: {} }); // 匹配 11:30
    mockedEnqueue.mockResolvedValue({ id: 'j', deduplicated: false });

    const result = await fireSchedules(new Date(Date.UTC(2026, 3, 27, 11, 30, 0)));
    expect(result.matched.sort()).toEqual(['a', 'c']);
    expect(mockedEnqueue).toHaveBeenCalledTimes(2);
  });

  it('某 schedule enqueue 抛错 → 不阻塞其它 schedule，logger.error', async () => {
    registerSchedule({ name: 'broken', cron: '* * * * *', jobType: 'unknown.job', payload: {} });
    registerSchedule({ name: 'ok', cron: '* * * * *', jobType: 'good.job', payload: {} });
    mockedEnqueue
      .mockRejectedValueOnce(new Error('unknown job type'))
      .mockResolvedValueOnce({ id: 'j', deduplicated: false });

    const result = await fireSchedules(new Date(Date.UTC(2026, 3, 27, 11, 30, 0)));
    expect(result.matched.sort()).toEqual(['broken', 'ok']);
    expect(result.enqueued).toEqual(['ok']);
    // broken 没进 enqueued / deduplicated 任何一个 —— 失败但不传染。
  });

  it('零 schedule → 空结果，不抛错', async () => {
    const result = await fireSchedules(new Date());
    expect(result.matched).toEqual([]);
    expect(result.enqueued).toEqual([]);
    expect(result.deduplicated).toEqual([]);
  });
});
