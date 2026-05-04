'use server';

import { OrgRole } from '@prisma/client';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/services/audit';
import { ACTIVE_ORG_COOKIE, requireActiveOrg } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

import { can } from './permissions';

const ACTIVE_ORG_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

const switchSchema = z.object({ slug: z.string().min(1).max(60) });

const updateOrgSchema = z.object({
  name: z.string().min(1).max(80),
  // 3..40 个字符，小写 + 数字 + dash，必须以字母数字开头和结尾
  slug: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/, 'invalid-slug')
    .refine((s) => !s.startsWith('personal-'), { message: 'reserved-slug' }),
});

const removeMemberSchema = z.object({ userId: z.string().min(1) });
const updateMemberRoleSchema = z.object({
  userId: z.string().min(1),
  role: z.nativeEnum(OrgRole),
});
const transferSchema = z.object({ userId: z.string().min(1) });
const deleteOrgSchema = z.object({ slugConfirm: z.string().min(1) });

/** 切换调用者的活跃组织（cookie）。调用者必须是成员。 */
export async function setActiveOrgAction(input: z.infer<typeof switchSchema>) {
  const me = await requireActiveOrg();
  const parsed = switchSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const target = await prisma.organization.findUnique({
    where: { slug: parsed.data.slug },
    select: {
      id: true,
      memberships: { where: { userId: me.userId }, select: { role: true } },
    },
  });
  if (!target || target.memberships.length === 0) {
    return { ok: false as const, error: 'not-a-member' as const };
  }

  const c = await cookies();
  c.set(ACTIVE_ORG_COOKIE, parsed.data.slug, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ACTIVE_ORG_COOKIE_MAX_AGE,
  });
  revalidatePath('/', 'layout');
  return { ok: true as const };
}

/** 重命名/重新设置活跃组织的 slug。 */
export async function updateOrgAction(input: z.infer<typeof updateOrgSchema>) {
  const me = await requireActiveOrg();
  if (!can(me.role, 'org.update')) {
    return { ok: false as const, error: 'forbidden' as const };
  }
  const parsed = updateOrgSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  // Slug 唯一性冲突 → 409 友好错误。
  if (parsed.data.slug !== me.slug) {
    const taken = await prisma.organization.findUnique({
      where: { slug: parsed.data.slug },
      select: { id: true },
    });
    if (taken && taken.id !== me.orgId) {
      return { ok: false as const, error: 'slug-taken' as const };
    }
  }

  // RFC 0005 — `region` 刻意不在 `updateOrgSchema` 中，
  // 这里的更新载荷仅列出 `name` + `slug`。Region 是 Org 的一个
  // 部署时不可变属性；任何尝试访问它的做法
  // 都必须同时绕过 zod schema 和这个显式允许列表。
  await prisma.organization.update({
    where: { id: me.orgId },
    data: { name: parsed.data.name, slug: parsed.data.slug },
  });

  // Slug 已更改 — 刷新 cookie 以便下一个请求仍能解析。
  if (parsed.data.slug !== me.slug) {
    const c = await cookies();
    c.set(ACTIVE_ORG_COOKIE, parsed.data.slug, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: ACTIVE_ORG_COOKIE_MAX_AGE,
    });
  }

  await recordAudit({
    actorId: me.userId,
    orgId: me.orgId,
    action: 'org.updated',
    metadata: { name: parsed.data.name, slug: parsed.data.slug },
  });

  revalidatePath('/settings/organization');
  return { ok: true as const, slug: parsed.data.slug };
}

/** 从活跃组织中移除成员。OWNER 无法被移除（需先转移）。 */
export async function removeMemberAction(input: z.infer<typeof removeMemberSchema>) {
  const me = await requireActiveOrg();
  if (!can(me.role, 'member.remove')) {
    return { ok: false as const, error: 'forbidden' as const };
  }
  const parsed = removeMemberSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const target = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId: me.orgId, userId: parsed.data.userId } },
    select: { role: true },
  });
  if (!target) return { ok: false as const, error: 'not-found' as const };
  if (target.role === OrgRole.OWNER) {
    return { ok: false as const, error: 'cannot-remove-owner' as const };
  }

  await prisma.membership.delete({
    where: { orgId_userId: { orgId: me.orgId, userId: parsed.data.userId } },
  });

  await recordAudit({
    actorId: me.userId,
    orgId: me.orgId,
    action: 'member.removed',
    target: parsed.data.userId,
    metadata: { role: target.role },
  });

  revalidatePath('/settings/members');
  return { ok: true as const };
}

/** 更改成员的角色。OWNER 角色被保留 — 使用 transferOwnership 来转移。 */
export async function updateMemberRoleAction(input: z.infer<typeof updateMemberRoleSchema>) {
  const me = await requireActiveOrg();
  if (!can(me.role, 'member.update_role')) {
    return { ok: false as const, error: 'forbidden' as const };
  }
  const parsed = updateMemberRoleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }
  if (parsed.data.role === OrgRole.OWNER) {
    return { ok: false as const, error: 'use-transfer' as const };
  }

  const target = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId: me.orgId, userId: parsed.data.userId } },
    select: { role: true },
  });
  if (!target) return { ok: false as const, error: 'not-found' as const };
  if (target.role === OrgRole.OWNER) {
    return { ok: false as const, error: 'cannot-demote-owner' as const };
  }

  await prisma.membership.update({
    where: { orgId_userId: { orgId: me.orgId, userId: parsed.data.userId } },
    data: { role: parsed.data.role },
  });

  await recordAudit({
    actorId: me.userId,
    orgId: me.orgId,
    action: 'member.role_changed',
    target: parsed.data.userId,
    metadata: { from: target.role, to: parsed.data.role },
  });

  revalidatePath('/settings/members');
  return { ok: true as const };
}

/**
 * 将所有权转移给另一个现有成员。原子性地将当前
 * OWNER → ADMIN 降级，并将目标 → OWNER 提升。
 */
export async function transferOwnershipAction(input: z.infer<typeof transferSchema>) {
  const me = await requireActiveOrg();
  if (!can(me.role, 'org.transfer_ownership')) {
    return { ok: false as const, error: 'forbidden' as const };
  }
  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }
  if (parsed.data.userId === me.userId) {
    return { ok: false as const, error: 'self-transfer' as const };
  }

  const target = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId: me.orgId, userId: parsed.data.userId } },
    select: { role: true },
  });
  if (!target) {
    return { ok: false as const, error: 'not-found' as const };
  }

  await prisma.$transaction([
    prisma.membership.update({
      where: { orgId_userId: { orgId: me.orgId, userId: me.userId } },
      data: { role: OrgRole.ADMIN },
    }),
    prisma.membership.update({
      where: { orgId_userId: { orgId: me.orgId, userId: parsed.data.userId } },
      data: { role: OrgRole.OWNER },
    }),
  ]);

  await recordAudit({
    actorId: me.userId,
    orgId: me.orgId,
    action: 'ownership.transferred',
    target: parsed.data.userId,
  });

  revalidatePath('/settings/members');
  revalidatePath('/settings/organization');
  return { ok: true as const };
}

/** 永久删除活跃组织。仅限 OWNER。需输入 slug 确认。 */
export async function deleteOrgAction(input: z.infer<typeof deleteOrgSchema>) {
  const me = await requireActiveOrg();
  if (!can(me.role, 'org.delete')) {
    return { ok: false as const, error: 'forbidden' as const };
  }
  const parsed = deleteOrgSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }
  if (parsed.data.slugConfirm !== me.slug) {
    return { ok: false as const, error: 'slug-mismatch' as const };
  }
  // 个人组织绑定到用户账户 — 拒绝在此删除，危险区 /settings（账户删除）
  // 是正确的地方。
  if (me.slug.startsWith('personal-')) {
    return { ok: false as const, error: 'personal-org' as const };
  }

  // 先记录审计（即使组织被删除后，该行名义上仍保留其 orgId；
  // AuditLog 在 orgId 上没有 FK，所以它幸存下来）。
  await recordAudit({
    actorId: me.userId,
    orgId: me.orgId,
    action: 'org.deleted',
    target: me.slug,
  });

  // 级联 FK（Membership / Invitation / Subscription / ApiToken）处理子数据。
  await prisma.organization.delete({ where: { id: me.orgId } });
  logger.info({ orgId: me.orgId, slug: me.slug, actor: me.userId }, 'org-deleted');

  // 清除活跃组织 cookie 以便用户回落到个人组织。
  const c = await cookies();
  c.delete(ACTIVE_ORG_COOKIE);

  revalidatePath('/', 'layout');
  return { ok: true as const };
}
