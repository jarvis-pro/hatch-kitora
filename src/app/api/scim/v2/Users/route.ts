import { OrgRole, type Prisma } from '@prisma/client';

import { recordAudit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { provisionSsoUser } from '@/lib/sso/jit';
import { authenticateScim, scimError, scimJson } from '@/lib/sso/scim-auth';
import {
  parseFilterField,
  parseUserNameEqFilter,
  roleFromGroupId,
  toScimUser,
} from '@/lib/sso/scim-user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-4 — SCIM Users collection.
 *
 *   GET  /api/scim/v2/Users[?filter=userName eq "x"&startIndex=1&count=20]
 *   POST /api/scim/v2/Users  — create User + Membership in the SCIM org
 *
 * The IdP-side connector calls GET first to discover existing users, then
 * POST to provision the ones it has assigned. Our `id` is the Membership
 * row id (per RFC 0004 §4.3) so SCIM DELETE later cleanly drops that
 * tenant's binding without disturbing the User row.
 */

export async function GET(request: Request) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return scimError(auth.status, auth.reason);

  const url = new URL(request.url);
  const filter = url.searchParams.get('filter');
  const startIndex = clampInt(url.searchParams.get('startIndex'), 1, 1, 10_000);
  const count = clampInt(url.searchParams.get('count'), 50, 0, 200);

  // Build the where-clause. Default → all (non-deleted) memberships in the
  // tenant. With an `eq` filter we narrow down — `userName` is the user's
  // email; `externalId` maps to `providerSubject`.
  const baseWhere: Prisma.MembershipWhereInput = {
    orgId: auth.orgId,
    deletedAt: null,
  };
  let where: Prisma.MembershipWhereInput = baseWhere;

  if (filter) {
    const field = parseFilterField(filter);
    const value = parseUserNameEqFilter(filter);
    if (!field || !value) {
      return scimError(400, `unsupported-filter: ${filter}`, { scimType: 'invalidFilter' });
    }
    where =
      field === 'userName'
        ? { ...baseWhere, user: { email: value.toLowerCase() } }
        : { ...baseWhere, providerSubject: value };
  }

  const [rows, totalResults] = await Promise.all([
    prisma.membership.findMany({
      where,
      skip: count === 0 ? 0 : Math.max(0, startIndex - 1),
      take: count === 0 ? 0 : count,
      orderBy: { joinedAt: 'asc' },
      select: {
        id: true,
        role: true,
        deletedAt: true,
        providerSubject: true,
        user: { select: { id: true, email: true, name: true } },
      },
    }),
    prisma.membership.count({ where }),
  ]);

  return scimJson(200, {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults,
    startIndex,
    itemsPerPage: rows.length,
    Resources: rows.map((r) =>
      toScimUser(
        {
          id: r.user.id,
          email: r.user.email,
          name: r.user.name,
          membershipId: r.id,
          role: r.role,
          deletedAt: r.deletedAt,
          providerSubject: r.providerSubject,
        },
        auth.orgSlug,
      ),
    ),
  });
}

interface CreateBody {
  schemas?: unknown;
  userName?: unknown;
  externalId?: unknown;
  name?: { givenName?: unknown; familyName?: unknown };
  active?: unknown;
  emails?: { value?: unknown; primary?: unknown }[];
  groups?: { value?: unknown }[];
}

export async function POST(request: Request) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return scimError(auth.status, auth.reason);

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return scimError(400, 'invalid-json');
  }

  const userName = stringField(body.userName);
  if (!userName) {
    return scimError(400, 'userName is required', { scimType: 'invalidValue' });
  }
  const email = userName.toLowerCase();

  const externalId = stringField(body.externalId);
  const givenName = stringField(body.name?.givenName);
  const familyName = stringField(body.name?.familyName);
  const composedName =
    [givenName, familyName]
      .filter((s): s is string => !!s)
      .join(' ')
      .trim() || null;

  // Group → role. Default MEMBER. We refuse OWNER per RFC 0004 §4.4: that
  // promotion has to happen inside Kitora.
  let role: OrgRole = OrgRole.MEMBER;
  if (Array.isArray(body.groups) && body.groups.length > 0) {
    for (const g of body.groups) {
      const v = stringField(g.value);
      if (!v) continue;
      const r = roleFromGroupId(v);
      if (r === null) continue;
      if (r === OrgRole.OWNER) {
        return scimError(400, 'OWNER cannot be assigned via SCIM', { scimType: 'noTarget' });
      }
      role = r;
    }
  }

  // Idempotency: if a membership with this externalId or email already
  // exists in the tenant, return 409 per SCIM convention.
  const existing = await prisma.membership.findFirst({
    where: {
      orgId: auth.orgId,
      OR: [
        ...(externalId ? [{ providerSubject: externalId, providerId: auth.idpId }] : []),
        { user: { email } },
      ],
    },
    select: { id: true },
  });
  if (existing) {
    return scimError(409, 'user already exists', { scimType: 'uniqueness' });
  }

  // Reuse the JIT pipeline so audit + (existing-user-by-email) handling
  // stays in lockstep with SAML/OIDC login provisioning.
  let jit;
  try {
    jit = await provisionSsoUser({
      providerId: auth.idpId,
      providerSubject: externalId ?? `scim:${userName}`,
      email,
      name: composedName,
      orgId: auth.orgId,
      defaultRole: role,
    });
  } catch (err) {
    logger.error({ err, userName }, 'scim-user-create-failed');
    return scimError(500, 'provision-failed');
  }

  const membership = await prisma.membership.findFirstOrThrow({
    where: { userId: jit.userId, orgId: auth.orgId },
    select: {
      id: true,
      role: true,
      deletedAt: true,
      providerSubject: true,
      user: { select: { id: true, email: true, name: true } },
    },
  });

  // SCIM defaults `active = true` on create. If the caller passed `active:
  // false` we honor it via deletedAt.
  if (body.active === false) {
    await prisma.membership.update({
      where: { id: membership.id },
      data: { deletedAt: new Date() },
    });
    membership.deletedAt = new Date();
  }

  // Promote to ADMIN if the create payload asked for it. (We pre-validated
  // OWNER above so this can only land on MEMBER or ADMIN.)
  if (role !== OrgRole.MEMBER && membership.role !== role) {
    await prisma.membership.update({ where: { id: membership.id }, data: { role } });
    membership.role = role;
  }

  await recordAudit({
    actorId: null,
    orgId: auth.orgId,
    action: 'scim.user_provisioned',
    target: membership.id,
    metadata: { email, externalId, role },
  });

  return scimJson(
    201,
    toScimUser(
      {
        id: membership.user.id,
        email: membership.user.email,
        name: membership.user.name,
        membershipId: membership.id,
        role: membership.role,
        deletedAt: membership.deletedAt,
        providerSubject: membership.providerSubject,
      },
      auth.orgSlug,
    ),
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function stringField(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
