/**
 * orgs/queries helper 单测。
 *
 * 这三个 helper 的核心 invariant 是「自动追加 deletedAt: null」—— 5 处 callsite
 * 已经按这个语义迁过来；如果将来谁手抖把 helper 改成裸 prisma.findFirst 又忘了加
 * 过滤，本测试套就会立即抛错挡住 PR。同时锁住「caller where 与 deletedAt: null
 * merge 不丢字段」「select/orderBy/take 透传」「caller 显式传 deletedAt 也会被
 * helper 覆盖（鼓励真要看软删除行的人走原生 prisma）」三条边界。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    membership: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db';

import { countActiveMemberships, findActiveMembership, listActiveMemberships } from './queries';

const mockedPrisma = prisma as unknown as {
  membership: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
};

beforeEach(() => {
  mockedPrisma.membership.findFirst.mockReset();
  mockedPrisma.membership.findMany.mockReset();
  mockedPrisma.membership.count.mockReset();
});

describe('findActiveMembership', () => {
  it('没传 where → 仍注入 deletedAt: null', async () => {
    mockedPrisma.membership.findFirst.mockResolvedValueOnce(null);
    await findActiveMembership({});
    expect(mockedPrisma.membership.findFirst).toHaveBeenCalledWith({
      where: { deletedAt: null },
    });
  });

  it('caller where 与 deletedAt: null merge，原字段保留', async () => {
    mockedPrisma.membership.findFirst.mockResolvedValueOnce(null);
    await findActiveMembership({
      where: { userId: 'u1', orgId: 'o1', role: 'OWNER' },
    });
    expect(mockedPrisma.membership.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', orgId: 'o1', role: 'OWNER', deletedAt: null },
    });
  });

  it('select / orderBy 等其它字段原样透传', async () => {
    mockedPrisma.membership.findFirst.mockResolvedValueOnce(null);
    await findActiveMembership({
      where: { userId: 'u1' },
      select: { role: true, orgId: true },
      orderBy: { joinedAt: 'asc' },
    });
    expect(mockedPrisma.membership.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', deletedAt: null },
      select: { role: true, orgId: true },
      orderBy: { joinedAt: 'asc' },
    });
  });

  it('caller 显式传 deletedAt：{ not: null } 也会被 helper 覆盖（语义合同）', async () => {
    mockedPrisma.membership.findFirst.mockResolvedValueOnce(null);
    await findActiveMembership({
      where: { userId: 'u1', deletedAt: { not: null } },
    });
    // 鼓励真要看软删除的人走原生 prisma —— 不让 helper 给「活跃」成员混入软删除行。
    expect(mockedPrisma.membership.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', deletedAt: null },
    });
  });

  it('返回值就是 prisma 调用的结果（透传）', async () => {
    const row = { id: 'm1', orgId: 'o1' };
    mockedPrisma.membership.findFirst.mockResolvedValueOnce(row);
    await expect(findActiveMembership({ where: { userId: 'u1' } })).resolves.toBe(row);
  });
});

describe('listActiveMemberships', () => {
  it('注入 deletedAt: null 并透传 caller where', async () => {
    mockedPrisma.membership.findMany.mockResolvedValueOnce([]);
    await listActiveMemberships({
      where: { orgId: 'o1', role: { in: ['OWNER', 'ADMIN'] } },
      select: { user: { select: { email: true } } },
    });
    expect(mockedPrisma.membership.findMany).toHaveBeenCalledWith({
      where: { orgId: 'o1', role: { in: ['OWNER', 'ADMIN'] }, deletedAt: null },
      select: { user: { select: { email: true } } },
    });
  });

  it('返回值就是 prisma 调用的结果（透传数组）', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    mockedPrisma.membership.findMany.mockResolvedValueOnce(rows);
    await expect(listActiveMemberships({ where: { orgId: 'o1' } })).resolves.toBe(rows);
  });
});

describe('countActiveMemberships', () => {
  it('完全不传参数也工作（默认 {}）', async () => {
    mockedPrisma.membership.count.mockResolvedValueOnce(0);
    await countActiveMemberships();
    expect(mockedPrisma.membership.count).toHaveBeenCalledWith({
      where: { deletedAt: null },
    });
  });

  it('传 where 时被 merge', async () => {
    mockedPrisma.membership.count.mockResolvedValueOnce(7);
    const n = await countActiveMemberships({ where: { orgId: 'o1' } });
    expect(n).toBe(7);
    expect(mockedPrisma.membership.count).toHaveBeenCalledWith({
      where: { orgId: 'o1', deletedAt: null },
    });
  });
});
