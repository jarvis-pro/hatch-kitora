/**
 * RFC 0008 §6 PR-3 — job.prune 单元测试。
 *
 * 验证：
 *   - defineJob 注册参数；
 *   - run 调 prisma.backgroundJob.deleteMany；
 *   - where 条件：status 在 4 个终态、deleteAt < now() 且非空；
 *   - 返回 { deleted: count }。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    backgroundJob: { deleteMany: vi.fn() },
  },
}));

import { prisma } from '@/lib/db';

import type { JobContext } from '../registry';
import { jobPruneJob } from './job-prune';

const mockedPrisma = prisma as unknown as {
  backgroundJob: { deleteMany: ReturnType<typeof vi.fn> };
};

function ctxStub(): JobContext<unknown> {
  const noop = vi.fn();
  const stubLogger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    silent: noop,
    level: 'info',
    child: vi.fn(),
  };
  stubLogger.child.mockReturnValue(stubLogger);
  return {
    payload: {},
    attempt: 1,
    jobId: 'test-job',
    workerId: 'test-worker',
    logger: stubLogger as unknown as JobContext<unknown>['logger'],
  };
}

describe('jobPruneJob defineJob 参数', () => {
  it('注册值正确', () => {
    expect(jobPruneJob.type).toBe('job.prune');
    expect(jobPruneJob.maxAttempts).toBe(1);
    expect(jobPruneJob.retentionDays).toBe(7);
    expect(jobPruneJob.retry).toBe('fixed');
    expect(jobPruneJob.timeoutMs).toBe(60_000);
  });
});

describe('jobPruneJob.run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('调 deleteMany，返回 { deleted: count }', async () => {
    mockedPrisma.backgroundJob.deleteMany.mockResolvedValueOnce({ count: 42 });

    const result = await jobPruneJob.run(ctxStub());

    expect(result).toEqual({ deleted: 42 });
    expect(mockedPrisma.backgroundJob.deleteMany).toHaveBeenCalledOnce();
  });

  it('where 限定终态 + deleteAt < now() 非空', async () => {
    mockedPrisma.backgroundJob.deleteMany.mockResolvedValueOnce({ count: 0 });

    await jobPruneJob.run(ctxStub());

    const arg = mockedPrisma.backgroundJob.deleteMany.mock.calls[0]?.[0] as {
      where: {
        status: { in: string[] };
        deleteAt: { lt: Date; not: null };
      };
    };
    expect(arg.where.status).toEqual({
      in: ['SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'CANCELED'],
    });
    expect(arg.where.deleteAt.not).toBeNull();
    expect(arg.where.deleteAt.lt).toBeInstanceOf(Date);
    // cutoff 应该 ≈ now（容忍 5s 抖动 — 函数调用栈本身耗时极小）
    const dt = Date.now() - arg.where.deleteAt.lt.getTime();
    expect(Math.abs(dt)).toBeLessThan(5_000);
  });

  it('零删除 → 返回 deleted=0，不抛错', async () => {
    mockedPrisma.backgroundJob.deleteMany.mockResolvedValueOnce({ count: 0 });
    const result = await jobPruneJob.run(ctxStub());
    expect(result).toEqual({ deleted: 0 });
  });
});
