import 'server-only';

import { OrgRole } from '@prisma/client';
import { cookies } from 'next/headers';

import { prisma } from '@/lib/db';

import { auth } from './index';

export const ACTIVE_ORG_COOKIE = 'kitora_active_org';

/**
 * Require an authenticated session — throws if missing. Server actions / RSC
 * boundary helper; callers should redirect to /login when this throws.
 */
export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error('unauthenticated');
  }
  return session.user;
}

export interface ActiveOrg {
  orgId: string;
  userId: string;
  role: OrgRole;
  slug: string;
}

/**
 * Resolve the caller's active organization.
 *
 * PR-3 contract:
 *   1. Read the `kitora_active_org` cookie. If it points to an org the user
 *      is a member of, return that.
 *   2. Otherwise (no cookie / stale cookie / org deleted), fall back to the
 *      user's Personal Org (the OWNER membership whose slug starts with
 *      `personal-`).
 *   3. If the user has no membership at all (e.g. an OAuth user the backfill
 *      never saw), lazily create their personal org. Idempotent via upsert,
 *      safe under concurrent requests.
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
    // Cookie pointed at an org we no longer belong to (deleted / removed).
    // Drop it; we'll fall through to the personal-org branch below.
  }

  // Personal org is the canonical fallback — sorted by joinedAt to keep it
  // stable across multiple memberships.
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

  // OAuth-created user that the migration never saw — bootstrap their
  // personal org now. Idempotent via upsert by slug; safe under concurrent
  // requests (only one wins, the rest land on `update: {}`).
  return ensurePersonalOrg(sessionUser.id);
}

async function ensurePersonalOrg(userId: string): Promise<ActiveOrg> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, name: true, stripeCustomerId: true },
  });
  const slug = `personal-${user.id.slice(-8)}`;

  const org = await prisma.organization.upsert({
    where: { slug },
    create: {
      slug,
      name: user.name ?? 'Personal',
      stripeCustomerId: user.stripeCustomerId,
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

/** Personal-org lookup with no cookie / session involvement. */
export async function getPersonalOrgIdForUser(userId: string): Promise<string | null> {
  const m = await prisma.membership.findFirst({
    where: { userId, role: OrgRole.OWNER },
    orderBy: { joinedAt: 'asc' },
    select: { orgId: true },
  });
  return m?.orgId ?? null;
}

/** List every org the user belongs to — used by the org switcher / /api/v1/me. */
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
