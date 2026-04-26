import 'server-only';

import { OrgRole } from '@prisma/client';

import { prisma } from '@/lib/db';

import { auth } from './index';

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
 * PR-2 contract: returns the user's Personal Org (the OWNER membership whose
 * org slug starts with "personal-"). If for any reason no membership exists
 * (OAuth-created user that the backfill never saw), we lazily create one
 * here — idempotent via upsert by slug, safe under concurrent requests.
 *
 * PR-3 will extend this to read the `kitora_active_org` cookie first and
 * fall back to the personal org only when the cookie is missing / invalid.
 */
export async function requireActiveOrg(): Promise<ActiveOrg> {
  const sessionUser = await requireUser();

  const existing = await prisma.membership.findFirst({
    where: { userId: sessionUser.id, role: OrgRole.OWNER },
    orderBy: { joinedAt: 'asc' },
    select: {
      role: true,
      organization: { select: { id: true, slug: true } },
    },
  });
  if (existing) {
    return {
      orgId: existing.organization.id,
      userId: sessionUser.id,
      role: existing.role,
      slug: existing.organization.slug,
    };
  }

  // Lazy backfill — OAuth users created post-PR-1 may land here on first
  // request. The same `personal-{shortId}` slug is what the migration script
  // uses, keeping every code path on a single canonical naming scheme.
  return ensurePersonalOrg(sessionUser.id);
}

async function ensurePersonalOrg(userId: string): Promise<ActiveOrg> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, name: true, stripeCustomerId: true },
  });
  const slug = `personal-${user.id.slice(-8)}`;

  // upsert wins the race when two concurrent requests both arrive at this
  // codepath for the same fresh user.
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

/**
 * Resolve the personal org for a given user without going through `auth()`.
 * Used by webhooks / API token bearer auth where there is no session cookie.
 */
export async function getPersonalOrgIdForUser(userId: string): Promise<string | null> {
  const m = await prisma.membership.findFirst({
    where: { userId, role: OrgRole.OWNER },
    orderBy: { joinedAt: 'asc' },
    select: { orgId: true },
  });
  return m?.orgId ?? null;
}
