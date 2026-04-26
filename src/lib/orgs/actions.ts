'use server';

import { OrgRole } from '@prisma/client';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { ACTIVE_ORG_COOKIE, requireActiveOrg } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

import { can } from './permissions';

const ACTIVE_ORG_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

const switchSchema = z.object({ slug: z.string().min(1).max(60) });

const updateOrgSchema = z.object({
  name: z.string().min(1).max(80),
  // 3..40 chars, lowercase + digits + dash, must start and end with alphanumeric
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

/** Switch the caller's active org (cookie). Caller must be a member. */
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

/** Rename / re-slug the active org. */
export async function updateOrgAction(input: z.infer<typeof updateOrgSchema>) {
  const me = await requireActiveOrg();
  if (!can(me.role, 'org.update')) {
    return { ok: false as const, error: 'forbidden' as const };
  }
  const parsed = updateOrgSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  // Slug uniqueness collision → 409 friendly error.
  if (parsed.data.slug !== me.slug) {
    const taken = await prisma.organization.findUnique({
      where: { slug: parsed.data.slug },
      select: { id: true },
    });
    if (taken && taken.id !== me.orgId) {
      return { ok: false as const, error: 'slug-taken' as const };
    }
  }

  // RFC 0005 — `region` is intentionally absent from `updateOrgSchema`,
  // and the update payload here lists only `name` + `slug`. Region is a
  // deploy-time-immutable property of an Org; any attempt to reach it
  // would have to bypass both the zod schema and this explicit allow-list.
  await prisma.organization.update({
    where: { id: me.orgId },
    data: { name: parsed.data.name, slug: parsed.data.slug },
  });

  // Slug changed — refresh the cookie so the next request still resolves.
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

/** Remove a member from the active org. OWNER cannot be removed (transfer first). */
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

/** Change a member's role. OWNER role is reserved — use transferOwnership for that. */
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
 * Transfer ownership to another existing member. Atomically demotes current
 * OWNER → ADMIN and promotes target → OWNER.
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

/** Permanently delete the active org. OWNER only. Type-the-slug confirmation. */
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
  // Personal orgs are bound to the user account — refuse to delete here, the
  // /settings danger zone (account deletion) is the right place for that.
  if (me.slug.startsWith('personal-')) {
    return { ok: false as const, error: 'personal-org' as const };
  }

  // Audit first (the row keeps its orgId nominally even after the org is
  // deleted; AuditLog has no FK on orgId, so it survives).
  await recordAudit({
    actorId: me.userId,
    orgId: me.orgId,
    action: 'org.deleted',
    target: me.slug,
  });

  // Cascading FKs (Membership / Invitation / Subscription / ApiToken) take care of children.
  await prisma.organization.delete({ where: { id: me.orgId } });
  logger.info({ orgId: me.orgId, slug: me.slug, actor: me.userId }, 'org-deleted');

  // Clear the active-org cookie so the user falls back to their personal org.
  const c = await cookies();
  c.delete(ACTIVE_ORG_COOKIE);

  revalidatePath('/', 'layout');
  return { ok: true as const };
}
