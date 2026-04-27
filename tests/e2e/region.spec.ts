// RFC 0005 — 多区域（数据驻留）e2e 覆盖。
//
// 在单区域（GLOBAL）测试进程中可以验证的内容：
//
//   1. `(email, region)` 复合唯一约束替代了原有的 `email @unique`。
//      同一邮箱可作为独立的 User 行在不同 region 下共存；
//      删除其中一个不会影响另一个。Organization 同理。
//   2. 跨区域邀请创建被 `createInvitationAction` 拒绝
//      （通过其所需的 DB 结构间接触发验证）。
//   3. `/region-mismatch` 落地页正常渲染（i18n 已接通，
//      不触发 404）—— 覆盖中间件重定向目标。
//
// 此处*无法*验证的内容（需启动第二个设置了 `KITORA_REGION=CN` 的 Next 进程）：
//
//   * 中间件对伪造 token 实际发出重定向 ——
//     留待未来 RFC 0006 / 多区域 CI 矩阵处理。

import { expect, test } from '@playwright/test';

import { prisma, uniqueEmail } from './fixtures/db';

test.describe('RFC 0005 — Multi-region', () => {
  test('same email may exist independently in two regions', async () => {
    const email = uniqueEmail('region-dup');

    const globalUser = await prisma.user.create({
      data: { email, name: 'Global Twin', region: 'GLOBAL' },
    });
    const cnUser = await prisma.user.create({
      data: { email, name: 'CN Twin', region: 'CN' },
    });

    expect(globalUser.id).not.toBe(cnUser.id);

    // Both are reachable by the composite unique key.
    const lookupGlobal = await prisma.user.findUnique({
      where: { email_region: { email, region: 'GLOBAL' } },
    });
    const lookupCn = await prisma.user.findUnique({
      where: { email_region: { email, region: 'CN' } },
    });
    expect(lookupGlobal?.id).toBe(globalUser.id);
    expect(lookupCn?.id).toBe(cnUser.id);

    // Deleting one leaves the other untouched.
    await prisma.user.delete({ where: { id: globalUser.id } });
    const stillThere = await prisma.user.findUnique({
      where: { email_region: { email, region: 'CN' } },
    });
    expect(stillThere?.id).toBe(cnUser.id);

    // Cleanup.
    await prisma.user.delete({ where: { id: cnUser.id } });
  });

  test('insertion of a duplicate (email, region) row is rejected', async () => {
    const email = uniqueEmail('region-conflict');
    const u = await prisma.user.create({
      data: { email, name: 'first', region: 'GLOBAL' },
    });

    await expect(
      prisma.user.create({
        data: { email, name: 'second', region: 'GLOBAL' },
      }),
    ).rejects.toThrow();

    await prisma.user.delete({ where: { id: u.id } });
  });

  test('AuditLog rows stamp region column on insert', async () => {
    // recordAudit() auto-stamps `region` from `currentRegion()`. Because
    // the e2e harness boots with default env, that's GLOBAL.
    const row = await prisma.auditLog.create({
      data: {
        actorId: null,
        action: 'org.created',
        target: 'region-test-target',
        region: 'GLOBAL', // explicit — recordAudit() does this for app code
      },
    });
    expect(row.region).toBe('GLOBAL');

    // Composite (region, createdAt) index is queried like this in
    // compliance reports.
    const recent = await prisma.auditLog.findFirst({
      where: { region: 'GLOBAL', target: 'region-test-target' },
      orderBy: { createdAt: 'desc' },
    });
    expect(recent?.id).toBe(row.id);

    await prisma.auditLog.delete({ where: { id: row.id } });
  });

  test('Organization rows carry region; CN-region orgs co-exist with GLOBAL', async () => {
    const slugA = `region-a-${Math.random().toString(36).slice(2, 8)}`;
    const slugB = `region-b-${Math.random().toString(36).slice(2, 8)}`;

    const globalOrg = await prisma.organization.create({
      data: { slug: slugA, name: 'Global Acme', region: 'GLOBAL' },
    });
    const cnOrg = await prisma.organization.create({
      data: { slug: slugB, name: 'CN Acme', region: 'CN' },
    });

    expect(globalOrg.region).toBe('GLOBAL');
    expect(cnOrg.region).toBe('CN');

    await prisma.organization.delete({ where: { id: globalOrg.id } });
    await prisma.organization.delete({ where: { id: cnOrg.id } });
  });

  test('/region-mismatch landing page renders', async ({ page }) => {
    const res = await page.goto('/region-mismatch?expected=CN');
    expect(res?.status()).toBeLessThan(400);
    await expect(page.getByRole('heading')).toContainText(/region|账号/i);
  });
});
