/**
 * RFC 0008 §4.2 / §7 / §6 PR-1 — enqueueJob / cancelJob 行为测试。
 *
 * 用 `vi.mock('@/lib/db')` 把 Prisma 整包替换为 vi.fn() 化的 stub —— claim / 崩溃恢复
 * 这种 SQL-level 行为留给 PR-5 的真 PG e2e；这里只验单元逻辑：
 *
 *   - 未注册 type → 抛错（dev/CI 早期阻断）；
 *   - payload 校验失败 → 抛错；
 *   - payload > 64KB → 抛错（防 jsonb 列被打爆）；
 *   - 成功路径：传给 prisma.create 的 data 形状对、返回 deduplicated=false；
 *   - P2002 + runId 非空 → swallow，findUnique 取现有行返回 deduplicated=true；
 *   - P2002 + runId 为 null → 不 swallow，仍上抛（约定：无 runId = 不在意去重）；
 *   - 非 P2002 错误 → 上抛；
 *   - cancelJob 返回 boolean 反映 updateMany.count。
 */

import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// vi.mock 自动 hoist 到所有 import 之上；后续 `import { prisma } from '@/lib/db'`
// 拿到的是这里的 stub。
vi.mock('@/lib/db', () => ({
  prisma: {
    backgroundJob: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db';

import { defineJob } from './define';
import { cancelJob, enqueueJob } from './enqueue';
import { __resetRegistry } from './registry';

const mockedPrisma = prisma as unknown as {
  backgroundJob: {
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};

function makeP2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
  });
}

describe('enqueueJob', () => {
  beforeEach(() => {
    __resetRegistry();
    vi.clearAllMocks();
  });

  it('未注册 type → 抛错', async () => {
    await expect(enqueueJob('test.unknown', {})).rejects.toThrow(/unknown job type/);
    expect(mockedPrisma.backgroundJob.create).not.toHaveBeenCalled();
  });

  it('payload 校验失败 → 抛错（不调 prisma.create）', async () => {
    defineJob({
      type: 'test.email',
      payloadSchema: z.object({ to: z.string().email() }),
      run: async () => null,
    });
    await expect(enqueueJob('test.email', { to: 'not-an-email' })).rejects.toThrow(
      /payload validation failed/,
    );
    expect(mockedPrisma.backgroundJob.create).not.toHaveBeenCalled();
  });

  it('payload > 64KB → 抛错', async () => {
    defineJob({
      type: 'test.big',
      payloadSchema: z.object({ blob: z.string() }),
      run: async () => null,
    });
    const huge = 'x'.repeat(70_000);
    await expect(enqueueJob('test.big', { blob: huge })).rejects.toThrow(/exceeds 64KB limit/);
    expect(mockedPrisma.backgroundJob.create).not.toHaveBeenCalled();
  });

  it('成功路径：调 prisma.backgroundJob.create + 返回 deduplicated=false', async () => {
    defineJob({
      type: 'test.ok',
      payloadSchema: z.object({ x: z.number() }),
      run: async () => null,
    });
    mockedPrisma.backgroundJob.create.mockResolvedValueOnce({ id: 'job-abc' });

    const out = await enqueueJob(
      'test.ok',
      { x: 42 },
      { runId: 'idem-1', priority: 50, delayMs: 5_000 },
    );

    expect(out).toEqual({ id: 'job-abc', deduplicated: false });
    expect(mockedPrisma.backgroundJob.create).toHaveBeenCalledOnce();

    const arg = mockedPrisma.backgroundJob.create.mock.calls[0]?.[0] as {
      data: {
        type: string;
        payload: unknown;
        runId: string | null;
        priority: number;
        queue: string;
        maxAttempts: number;
        nextAttemptAt: Date;
      };
      select: unknown;
    };
    expect(arg.data.type).toBe('test.ok');
    expect(arg.data.payload).toEqual({ x: 42 });
    expect(arg.data.runId).toBe('idem-1');
    expect(arg.data.priority).toBe(50);
    expect(arg.data.maxAttempts).toBe(5); // defineJob default
    expect(arg.data.queue).toBe('default');

    // delayMs=5000 → nextAttemptAt 大约 5s 后（容忍 2s 抖动避免 CI 卡顿）
    const dt = arg.data.nextAttemptAt.getTime() - Date.now();
    expect(dt).toBeGreaterThan(3_000);
    expect(dt).toBeLessThan(7_000);
  });

  it('runId 撞 (type, runId) unique（P2002）→ swallow，返回 deduplicated=true', async () => {
    defineJob({
      type: 'test.idempotent',
      payloadSchema: z.object({}),
      run: async () => null,
    });
    mockedPrisma.backgroundJob.create.mockRejectedValueOnce(makeP2002());
    mockedPrisma.backgroundJob.findUnique.mockResolvedValueOnce({ id: 'existing-id' });

    const out = await enqueueJob('test.idempotent', {}, { runId: 'dup-key' });

    expect(out).toEqual({ id: 'existing-id', deduplicated: true });
    expect(mockedPrisma.backgroundJob.findUnique).toHaveBeenCalledWith({
      where: { type_runId: { type: 'test.idempotent', runId: 'dup-key' } },
      select: { id: true },
    });
  });

  it('P2002 + runId 为 null → 不 swallow，仍上抛（无 runId = 不在意去重）', async () => {
    defineJob({
      type: 'test.no-dedup',
      payloadSchema: z.object({}),
      run: async () => null,
    });
    mockedPrisma.backgroundJob.create.mockRejectedValueOnce(makeP2002());

    await expect(enqueueJob('test.no-dedup', {})).rejects.toThrow();
    expect(mockedPrisma.backgroundJob.findUnique).not.toHaveBeenCalled();
  });

  it('非 P2002 的 prisma 错误 → 直接上抛', async () => {
    defineJob({ type: 'test.err', payloadSchema: z.object({}), run: async () => null });
    mockedPrisma.backgroundJob.create.mockRejectedValueOnce(new Error('connection lost'));

    await expect(enqueueJob('test.err', {}, { runId: 'r' })).rejects.toThrow('connection lost');
    expect(mockedPrisma.backgroundJob.findUnique).not.toHaveBeenCalled();
  });

  it('delayMs=0 / undefined → nextAttemptAt 立即（≈ now）', async () => {
    defineJob({
      type: 'test.now',
      payloadSchema: z.object({}),
      run: async () => null,
    });
    mockedPrisma.backgroundJob.create.mockResolvedValueOnce({ id: 'j' });

    await enqueueJob('test.now', {});

    const arg = mockedPrisma.backgroundJob.create.mock.calls[0]?.[0] as {
      data: { nextAttemptAt: Date };
    };
    const dt = arg.data.nextAttemptAt.getTime() - Date.now();
    expect(Math.abs(dt)).toBeLessThan(1_000);
  });
});

describe('cancelJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('返回 true 当 PENDING 行被翻 CANCELED', async () => {
    mockedPrisma.backgroundJob.updateMany.mockResolvedValueOnce({ count: 1 });

    expect(await cancelJob('id-1')).toBe(true);
    expect(mockedPrisma.backgroundJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'id-1', status: 'PENDING' },
      data: { status: 'CANCELED', completedAt: expect.any(Date) },
    });
  });

  it('返回 false 当行不存在或已不在 PENDING（被 worker claim 或已 cancel）', async () => {
    mockedPrisma.backgroundJob.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await cancelJob('id-2')).toBe(false);
  });
});
