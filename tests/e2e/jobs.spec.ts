import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import { prisma } from './fixtures/db';
import { expect, test } from './fixtures/test';

import { cancelJob, enqueueJob } from '../../src/lib/jobs/enqueue';
import { registerJob } from '../../src/lib/jobs/registry';
import { runWorkerTick } from '../../src/lib/jobs/runner';

/**
 * RFC 0008 PR-5 — Background jobs e2e。
 *
 * 走真 PG 验证整条 enqueue → claim (`FOR UPDATE SKIP LOCKED`) → handler →
 * 终态 / 重试 / DLQ 的状态机：
 *
 *   1. **success** —— handler 返回值 → 行翻 SUCCEEDED + result + deleteAt；
 *   2. **retry** —— handler 抛错且 attempt < maxAttempts → PENDING + lastError +
 *      nextAttemptAt 推后；
 *   3. **dead-letter** —— handler 抛错且 attempt >= maxAttempts → DEAD_LETTER +
 *      lastError + deleteAt；
 *   4. **cancel** —— PENDING 行调 `cancelJob()` → CANCELED + completedAt。
 *
 * 每个 test 用唯一 jobType 名字（`e2e.test-<rand>`）避免与其它 spec / dev jobs
 * 注册冲突；测试结尾自己清理 backgroundJob 行。
 *
 * 不测：admin route 路径（cancelJobAction / retryJobAction）—— 那些走
 * requireAdmin gate，由 admin/actions 单测覆盖；这层只验 lib 状态机。
 */

function uniqueType(): string {
  return `e2e.test-${randomBytes(8).toString('hex')}`;
}

function uniqueWorkerId(): string {
  return `e2e-worker-${randomBytes(4).toString('hex')}`;
}

test.describe('RFC 0008 background jobs (lib state machine)', () => {
  test('enqueue → tick → SUCCEEDED + result + deleteAt set', async () => {
    const type = uniqueType();
    registerJob({
      type,
      payloadSchema: z.object({ x: z.number() }),
      maxAttempts: 1,
      retentionDays: 1,
      retry: 'fixed',
      queue: 'default',
      timeoutMs: 5_000,
      run: async ({ payload }) => {
        const p = payload as { x: number };
        return { doubled: p.x * 2 };
      },
    });

    const enq = await enqueueJob(type, { x: 21 });
    expect(enq.deduplicated).toBe(false);

    const tick = await runWorkerTick(uniqueWorkerId(), {
      batchSize: 1,
      budgetMs: 10_000,
    });
    expect(tick.succeeded).toBeGreaterThanOrEqual(1);

    const row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: enq.id } });
    expect(row.status).toBe('SUCCEEDED');
    expect(row.attempt).toBe(1);
    expect(row.result).toEqual({ doubled: 42 });
    expect(row.completedAt).not.toBeNull();
    expect(row.deleteAt).not.toBeNull();
    expect(row.lockedBy).toBeNull();
    expect(row.lockedAt).toBeNull();

    await prisma.backgroundJob.delete({ where: { id: enq.id } });
  });

  test('enqueue → tick (handler 抛错 + attempt < maxAttempts) → PENDING + lastError', async () => {
    const type = uniqueType();
    registerJob({
      type,
      payloadSchema: z.object({}),
      maxAttempts: 3, // 还有 retry 余量
      retentionDays: 1,
      retry: 'fixed',
      queue: 'default',
      timeoutMs: 5_000,
      run: async () => {
        throw new Error('intentional-fail-retry');
      },
    });

    const enq = await enqueueJob(type, {});
    const beforeTick = Date.now();
    await runWorkerTick(uniqueWorkerId(), { batchSize: 1, budgetMs: 5_000 });

    const row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: enq.id } });
    expect(row.status).toBe('PENDING');
    expect(row.attempt).toBe(1);
    expect(row.lastError).toContain('intentional-fail-retry');
    // fixed retry = 60s 后；nextAttemptAt 必然在未来。
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(beforeTick + 30_000);
    expect(row.lockedBy).toBeNull();
    expect(row.lockedAt).toBeNull();
    // PENDING 行不写 deleteAt。
    expect(row.deleteAt).toBeNull();

    await prisma.backgroundJob.delete({ where: { id: enq.id } });
  });

  test('enqueue → tick (handler 抛错 + maxAttempts=1) → DEAD_LETTER + deleteAt', async () => {
    const type = uniqueType();
    registerJob({
      type,
      payloadSchema: z.object({}),
      maxAttempts: 1, // 失败一次直接 DLQ
      retentionDays: 7,
      retry: 'fixed',
      queue: 'default',
      timeoutMs: 5_000,
      run: async () => {
        throw new Error('fatal-fail-dlq');
      },
    });

    const enq = await enqueueJob(type, {});
    const tick = await runWorkerTick(uniqueWorkerId(), { batchSize: 1, budgetMs: 5_000 });
    expect(tick.deadLettered).toBeGreaterThanOrEqual(1);

    const row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: enq.id } });
    expect(row.status).toBe('DEAD_LETTER');
    expect(row.lastError).toContain('fatal-fail-dlq');
    expect(row.completedAt).not.toBeNull();
    expect(row.deleteAt).not.toBeNull();
    // retentionDays=7 → deleteAt ≈ now + 7d
    expect(row.deleteAt!.getTime() - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(row.deleteAt!.getTime() - Date.now()).toBeLessThan(8 * 24 * 60 * 60 * 1000);

    await prisma.backgroundJob.delete({ where: { id: enq.id } });
  });

  test('cancelJob：PENDING 行 → CANCELED + completedAt set', async () => {
    const type = uniqueType();
    registerJob({
      type,
      payloadSchema: z.object({}),
      maxAttempts: 1,
      retentionDays: 1,
      retry: 'fixed',
      queue: 'default',
      timeoutMs: 5_000,
      // delayMs 让行不会立刻被 claim 跑；保持 PENDING 给 cancel 测试。
      run: async () => null,
    });

    const enq = await enqueueJob(type, {}, { delayMs: 60 * 60 * 1000 });
    expect(enq.deduplicated).toBe(false);

    // 此时行是 PENDING + nextAttemptAt 在 1h 后；cancel 应能翻 CANCELED。
    const cancelled = await cancelJob(enq.id);
    expect(cancelled).toBe(true);

    const row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: enq.id } });
    expect(row.status).toBe('CANCELED');
    expect(row.completedAt).not.toBeNull();

    // 重复 cancel 已 CANCELED 行返回 false（不在 PENDING）。
    const second = await cancelJob(enq.id);
    expect(second).toBe(false);

    await prisma.backgroundJob.delete({ where: { id: enq.id } });
  });

  test('runId 重复 enqueue → P2002 swallow 返回同 id (deduplicated=true)', async () => {
    const type = uniqueType();
    registerJob({
      type,
      payloadSchema: z.object({}),
      maxAttempts: 1,
      retentionDays: 1,
      retry: 'fixed',
      queue: 'default',
      timeoutMs: 5_000,
      run: async () => null,
    });

    const runId = `e2e-idem-${randomBytes(4).toString('hex')}`;
    const first = await enqueueJob(type, {}, { runId, delayMs: 60_000 });
    expect(first.deduplicated).toBe(false);

    const second = await enqueueJob(type, {}, { runId, delayMs: 60_000 });
    expect(second.deduplicated).toBe(true);
    expect(second.id).toBe(first.id);

    await prisma.backgroundJob.delete({ where: { id: first.id } });
  });
});
