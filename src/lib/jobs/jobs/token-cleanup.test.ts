/**
 * RFC 0008 §6 PR-3 — token.cleanup job 单元测试。
 *
 * mock 掉 @/lib/db 的 3 个 deleteMany，直接调 `tokenCleanupJob.run(ctxStub)`
 * 验证：
 *   - defineJob 注册参数（type / maxAttempts / retentionDays / retry / timeoutMs）；
 *   - 三个 deleteMany 都被调用，返回值汇总到结果对象；
 *   - PasswordResetToken / EmailVerificationToken 的 OR 条件含 `consumedAt 非空`
 *     与 `expires < cutoff`；
 *   - Invitation 的 OR 条件含 `acceptedAt / revokedAt / expiresAt`。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    passwordResetToken: { deleteMany: vi.fn() },
    emailVerificationToken: { deleteMany: vi.fn() },
    invitation: { deleteMany: vi.fn() },
  },
}));

import { prisma } from '@/lib/db';

import type { JobContext } from '../registry';
import { tokenCleanupJob } from './token-cleanup';

const mockedPrisma = prisma as unknown as {
  passwordResetToken: { deleteMany: ReturnType<typeof vi.fn> };
  emailVerificationToken: { deleteMany: ReturnType<typeof vi.fn> };
  invitation: { deleteMany: ReturnType<typeof vi.fn> };
};

function ctxStub(): JobContext<unknown> {
  // self-referencing logger stub —— `.child()` 必须返回同形状的 logger（runner.ts
  // 真实生产会绑 `{ jobId, jobType }`，单测只需拿到 child 不抛即可）。
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

describe('tokenCleanupJob defineJob 参数', () => {
  it('注册值 = type=token.cleanup / maxAttempts=1 / retentionDays=7 / retry=fixed / timeoutMs=30000', () => {
    expect(tokenCleanupJob.type).toBe('token.cleanup');
    expect(tokenCleanupJob.maxAttempts).toBe(1);
    expect(tokenCleanupJob.retentionDays).toBe(7);
    expect(tokenCleanupJob.retry).toBe('fixed');
    expect(tokenCleanupJob.timeoutMs).toBe(30_000);
    expect(tokenCleanupJob.queue).toBe('default');
  });
});

describe('tokenCleanupJob.run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('三个 deleteMany 都被调用，count 汇总到结果', async () => {
    mockedPrisma.passwordResetToken.deleteMany.mockResolvedValueOnce({ count: 3 });
    mockedPrisma.emailVerificationToken.deleteMany.mockResolvedValueOnce({ count: 5 });
    mockedPrisma.invitation.deleteMany.mockResolvedValueOnce({ count: 2 });

    const result = await tokenCleanupJob.run(ctxStub());

    expect(result).toEqual({
      passwordResetTokens: 3,
      emailVerificationTokens: 5,
      invitations: 2,
    });
    expect(mockedPrisma.passwordResetToken.deleteMany).toHaveBeenCalledOnce();
    expect(mockedPrisma.emailVerificationToken.deleteMany).toHaveBeenCalledOnce();
    expect(mockedPrisma.invitation.deleteMany).toHaveBeenCalledOnce();
  });

  it('PasswordResetToken 删除条件：consumedAt 非空 OR expires < 7d-ago cutoff', async () => {
    mockedPrisma.passwordResetToken.deleteMany.mockResolvedValueOnce({ count: 0 });
    mockedPrisma.emailVerificationToken.deleteMany.mockResolvedValueOnce({ count: 0 });
    mockedPrisma.invitation.deleteMany.mockResolvedValueOnce({ count: 0 });

    await tokenCleanupJob.run(ctxStub());

    const arg = mockedPrisma.passwordResetToken.deleteMany.mock.calls[0]?.[0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    expect(arg.where.OR).toEqual([
      { consumedAt: { not: null } },
      { expires: { lt: expect.any(Date) } },
    ]);
    // cutoff 大约在 7 天前（容忍 1 分钟抖动）
    const cutoff = (arg.where.OR[1] as { expires: { lt: Date } }).expires.lt;
    const ageMs = Date.now() - cutoff.getTime();
    expect(ageMs).toBeGreaterThan(7 * 24 * 60 * 60 * 1000 - 60_000);
    expect(ageMs).toBeLessThan(7 * 24 * 60 * 60 * 1000 + 60_000);
  });

  it('Invitation 删除条件：acceptedAt / revokedAt / expiresAt < 30d-ago', async () => {
    mockedPrisma.passwordResetToken.deleteMany.mockResolvedValueOnce({ count: 0 });
    mockedPrisma.emailVerificationToken.deleteMany.mockResolvedValueOnce({ count: 0 });
    mockedPrisma.invitation.deleteMany.mockResolvedValueOnce({ count: 0 });

    await tokenCleanupJob.run(ctxStub());

    const arg = mockedPrisma.invitation.deleteMany.mock.calls[0]?.[0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    expect(arg.where.OR).toEqual([
      { acceptedAt: { not: null } },
      { revokedAt: { not: null } },
      { expiresAt: { lt: expect.any(Date) } },
    ]);
    // 30d cutoff
    const cutoff = (arg.where.OR[2] as { expiresAt: { lt: Date } }).expiresAt.lt;
    const ageMs = Date.now() - cutoff.getTime();
    expect(ageMs).toBeGreaterThan(30 * 24 * 60 * 60 * 1000 - 60_000);
    expect(ageMs).toBeLessThan(30 * 24 * 60 * 60 * 1000 + 60_000);
  });

  it('零行删除 → 仍返回结果对象（不抛）', async () => {
    mockedPrisma.passwordResetToken.deleteMany.mockResolvedValueOnce({ count: 0 });
    mockedPrisma.emailVerificationToken.deleteMany.mockResolvedValueOnce({ count: 0 });
    mockedPrisma.invitation.deleteMany.mockResolvedValueOnce({ count: 0 });

    const result = await tokenCleanupJob.run(ctxStub());
    expect(result).toEqual({
      passwordResetTokens: 0,
      emailVerificationTokens: 0,
      invitations: 0,
    });
  });
});
