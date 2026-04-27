import 'server-only';

import { OrgRole } from '@prisma/client';
import { cookies } from 'next/headers';

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
 */
export async function requireActiveOrg(): Promise<ActiveOrg> {
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
}

async function ensurePersonalOrg(userId: string): Promise<ActiveOrg> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, name: true },
  });
  const slug = `personal-${user.id.slice(-8)}`;

  const org = await prisma.organization.upsert({
    where: { slug },
    create: {
      slug,
      name: user.name ?? 'Personal',
    },
    update: {},
    select: { id: true, slug: true },
  });

  await prisma.membership.upsert({
    where: { orgId_userId: { orgId: org.id, userId } },
    create: { orgId: org.id, userId, role: OrgRole.OWNER },
    update: {},
  });

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
