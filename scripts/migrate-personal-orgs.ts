/**
 * scripts/migrate-personal-orgs.ts
 *
 * Idempotent backfill for RFC-0001 multi-tenancy migration (PR-1).
 *
 * 对每个现存 User：
 *   1. 创建 Personal Org（slug = `personal-{userId 末 8 字符}`），upsert by slug。
 *   2. 把 User.stripeCustomerId 复制到 Org.stripeCustomerId（仅在 Org 上还没值时）。
 *   3. 建立 OWNER Membership，upsert by (orgId, userId)。
 *   4. 把该 user 名下未关联 org 的 Subscription / ApiToken / AuditLog 回填 orgId。
 *
 * 重跑安全：所有写入都走 upsert / where orgId IS NULL，二次执行不会重复建表行。
 *
 * 用法：
 *   pnpm db:backfill-orgs                 # package.json 已加 alias
 *   tsx scripts/migrate-personal-orgs.ts  # 直接跑也行
 *
 * 环境变量：
 *   DATABASE_URL  必填，与 Next.js 运行时同源。
 *   DRY_RUN=1     仅打印计划，不写任何数据。
 */

import { OrgRole, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === '1';

function personalSlug(userId: string): string {
  // cuid 末段是高熵随机字符串，截 8 位足以保证 personal-* 全局唯一
  return `personal-${userId.slice(-8)}`;
}

async function ensurePersonalOrg(userId: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, name: true, stripeCustomerId: true },
  });
  const slug = personalSlug(user.id);

  if (DRY_RUN) {
    const existing = await prisma.organization.findUnique({ where: { slug } });
    return existing?.id ?? `<would-create:${slug}>`;
  }

  // upsert by slug —— 重跑不会重复创建；create 路径才搬 stripeCustomerId。
  const org = await prisma.organization.upsert({
    where: { slug },
    create: {
      slug,
      name: user.name ?? 'Personal',
      stripeCustomerId: user.stripeCustomerId,
    },
    update: {},
  });

  // upsert membership by 复合 unique (orgId, userId)
  await prisma.membership.upsert({
    where: { orgId_userId: { orgId: org.id, userId } },
    create: { orgId: org.id, userId, role: OrgRole.OWNER },
    update: {},
  });

  return org.id;
}

async function main() {
  const start = Date.now();
  console.log(`[backfill] mode=${DRY_RUN ? 'DRY_RUN' : 'LIVE'}`);

  const users = await prisma.user.findMany({
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`[backfill] processing ${users.length} users`);

  let processed = 0;
  let failed = 0;
  let backfilledSubs = 0;
  let backfilledTokens = 0;
  let backfilledAudit = 0;

  for (const { id: userId } of users) {
    try {
      const orgId = await ensurePersonalOrg(userId);

      if (DRY_RUN) {
        const [subs, tokens, audits] = await Promise.all([
          prisma.subscription.count({ where: { userId, orgId: null } }),
          prisma.apiToken.count({ where: { userId, orgId: null } }),
          prisma.auditLog.count({ where: { actorId: userId, orgId: null } }),
        ]);
        backfilledSubs += subs;
        backfilledTokens += tokens;
        backfilledAudit += audits;
      } else {
        const [subRes, tokRes, auditRes] = await Promise.all([
          prisma.subscription.updateMany({
            where: { userId, orgId: null },
            data: { orgId },
          }),
          prisma.apiToken.updateMany({
            where: { userId, orgId: null },
            data: { orgId },
          }),
          // AuditLog 用 actorId（与 RFC 一致：actor 触发的动作落到该 actor 的
          // personal org；platform-admin / 系统动作 actorId 为 null，留 orgId null）
          prisma.auditLog.updateMany({
            where: { actorId: userId, orgId: null },
            data: { orgId },
          }),
        ]);
        backfilledSubs += subRes.count;
        backfilledTokens += tokRes.count;
        backfilledAudit += auditRes.count;
      }

      processed++;
    } catch (e) {
      failed++;
      console.error(`[backfill] user ${userId} failed:`, e);
    }
  }

  const dur = Math.round((Date.now() - start) / 1000);
  console.log(
    `[backfill] done in ${dur}s — processed=${processed} failed=${failed} ` +
      `subs=${backfilledSubs} tokens=${backfilledTokens} audit=${backfilledAudit}`,
  );

  // Sanity：跑完后任一 user 仍无 membership 即视为失败。
  if (!DRY_RUN) {
    const orphan = await prisma.user.count({
      where: { memberships: { none: {} } },
    });
    if (orphan > 0) {
      console.error(`[backfill] ✗ ${orphan} user(s) still without membership`);
      process.exit(2);
    }
    console.log('[backfill] ✓ every user has at least one membership');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
