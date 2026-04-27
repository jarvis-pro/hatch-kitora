import 'server-only';

import { OrgRole } from '@prisma/client';
import { cookies } from 'next/headers';
import { cache } from 'react';

import { prisma } from '@/lib/db';

import { auth } from './index';

export const ACTIVE_ORG_COOKIE = 'kitora_active_org';

/**
 * 需要一个认证会话 — 如果缺失则抛出。服务器操作 / RSC
 * 边界辅助函数；当此抛出时，调用者应重定向到 /login。
 */
export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error('unauthenticated');
  }
  return session.user;
}

/**
 * 解析调用者当前设备会话的 sha256(sid)（如果有的话）。
 * 对于不携带 sid 的旧版（pre-RFC-0002）JWT 返回 `null` —
 * 这类请求仍可以看到活跃会话列表，只是没有"当前"徽章。
 */
export async function getCurrentSidHash(): Promise<string | null> {
  const session = await auth();
  return session?.sidHash ?? null;
}

export interface ActiveOrg {
  orgId: string;
  userId: string;
  role: OrgRole;
  slug: string;
}

/**
 * 解析调用者的活跃组织。
 *
 * PR-3 契约：
 *   1. 读取 `kitora_active_org` cookie。如果它指向用户
 *      是成员的组织，返回该组织。
 *   2. 否则（无 cookie / 陈旧 cookie / 组织已删除），
 *      回落到用户的个人组织（OWNER 成员关系，其 slug
 *      以 `personal-` 开头）。
 *   3. 如果用户根本没有成员关系（例如回填从未看到的 OAuth
 *      用户），延迟创建他们的个人组织。通过 upsert 幂等，
 *      在并发请求下安全。
 *
 * 用 React 18 的 `cache()` 包一层 —— App Router 渲染同一个 dashboard
 * 页面时 layout 和 page 都会调到这个函数，cache 让它们在单次渲染内
 * 共享同一个 promise，避免：
 *   * 重复读 cookie + 两次 membership 查询
 *   * `ensurePersonalOrg` 被并发触发时撞 P2002（即便有 try/catch
 *     兜底，Prisma 仍会把错误 emit 到 stderr，造成噪音 + 多余 SQL）
 * 跨请求并发（同一用户两个标签页 / 双击）依然要靠 `ensurePersonalOrg`
 * 内部的 P2002 兜底护住，cache 只覆盖单请求渲染期。
 */
export const requireActiveOrg = cache(async (): Promise<ActiveOrg> => {
  const sessionUser = await requireUser();

  const c = await cookies();
  const cookieSlug = c.get(ACTIVE_ORG_COOKIE)?.value;

  if (cookieSlug) {
    const cookieMembership = await prisma.membership.findFirst({
      where: { userId: sessionUser.id, organization: { slug: cookieSlug } },
      select: {
        role: true,
        organization: { select: { id: true, slug: true } },
      },
    });
    if (cookieMembership) {
      return {
        orgId: cookieMembership.organization.id,
        userId: sessionUser.id,
        role: cookieMembership.role,
        slug: cookieMembership.organization.slug,
      };
    }
    // Cookie 指向我们不再属于的组织（已删除 / 被移除）。
    // 删除它；我们将降至下面的个人组织分支。
  }

  // 个人组织是规范的回落 — 按 joinedAt 排序以在
  // 多个成员关系中保持其稳定。
  const personal = await prisma.membership.findFirst({
    where: { userId: sessionUser.id, role: OrgRole.OWNER },
    orderBy: { joinedAt: 'asc' },
    select: {
      role: true,
      organization: { select: { id: true, slug: true } },
    },
  });
  if (personal) {
    return {
      orgId: personal.organization.id,
      userId: sessionUser.id,
      role: personal.role,
      slug: personal.organization.slug,
    };
  }

  // OAuth 创建的用户，迁移从未看到 — 现在引导他们的
  // 个人组织。通过 slug 的 upsert 幂等；在并发
  // 请求下安全（只有一个赢，其余落在 `update: {}`）。
  return ensurePersonalOrg(sessionUser.id);
});

/**
 * Prisma 唯一约束错误码。`upsert` 在并发下不是单条原子 SQL，而是
 * SELECT + INSERT/UPDATE 两步：两个并发请求都 SELECT 不到行就都尝试
 * INSERT，DB 唯一索引会让后到的那个抛 P2002。我们靠这个码识别 race，
 * 然后退回 findUnique 拿胜出方写入的行（幂等结果一致）。
 *
 * App Router 在渲染同一个 dashboard 页面时会并发渲染 layout 和 page，
 * 两边都会走 requireActiveOrg → ensurePersonalOrg；这就是 race 的
 * 真实触发场景，详见 RFC 0002 PR-3 兜底注释。
 */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

async function ensurePersonalOrg(userId: string): Promise<ActiveOrg> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, name: true },
  });
  const slug = `personal-${user.id.slice(-8)}`;

  // Organization 行：upsert + P2002 兜底。
  let org;
  try {
    org = await prisma.organization.upsert({
      where: { slug },
      create: {
        slug,
        name: user.name ?? 'Personal',
      },
      update: {},
      select: { id: true, slug: true },
    });
  } catch (err) {
    if ((err as { code?: string }).code !== PRISMA_UNIQUE_VIOLATION) throw err;
    org = await prisma.organization.findUniqueOrThrow({
      where: { slug },
      select: { id: true, slug: true },
    });
  }

  // Membership 行：同样 upsert + P2002 兜底。并发胜出方已建好则吞掉。
  try {
    await prisma.membership.upsert({
      where: { orgId_userId: { orgId: org.id, userId } },
      create: { orgId: org.id, userId, role: OrgRole.OWNER },
      update: {},
    });
  } catch (err) {
    if ((err as { code?: string }).code !== PRISMA_UNIQUE_VIOLATION) throw err;
  }

  return {
    orgId: org.id,
    userId,
    role: OrgRole.OWNER,
    slug: org.slug,
  };
}

/** 无 cookie / 会话参与的个人组织查找。 */
export async function getPersonalOrgIdForUser(userId: string): Promise<string | null> {
  const m = await prisma.membership.findFirst({
    where: { userId, role: OrgRole.OWNER },
    orderBy: { joinedAt: 'asc' },
    select: { orgId: true },
  });
  return m?.orgId ?? null;
}

/** 列出用户所属的每个组织 — 由组织切换器 / /api/v1/me 使用。 */
export async function listMyOrgs(userId: string) {
  return prisma.membership.findMany({
    where: { userId },
    orderBy: { joinedAt: 'asc' },
    select: {
      role: true,
      organization: {
        select: { id: true, slug: true, name: true, image: true },
      },
    },
  });
}
