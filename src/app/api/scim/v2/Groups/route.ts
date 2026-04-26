import { OrgRole } from '@prisma/client';

import { prisma } from '@/lib/db';
import { authenticateScim, scimError, scimJson } from '@/lib/sso/scim-auth';
import { groupDisplayName, groupIdForRole } from '@/lib/sso/scim-user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-4 — SCIM Groups list.
 *
 * We expose three static groups per tenant: `Owners`, `Admins`,
 * `Members`. They're not real Prisma rows — they're a projection over
 * `Membership.role`. IdP connectors still expect group resources to
 * discover, so we synthesise them here.
 *
 * IT can flip a user's role by PATCHing the user (preferred) or by
 * PATCHing the group with `add`/`remove` member ops (handled in the
 * by-id route). OWNER is read-only via SCIM (RFC 0004 §4.4).
 */
export async function GET(request: Request) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return scimError(auth.status, auth.reason);

  const counts = await prisma.membership.groupBy({
    by: ['role'],
    where: { orgId: auth.orgId, deletedAt: null },
    _count: { _all: true },
  });
  const countByRole = new Map<OrgRole, number>();
  for (const c of counts) countByRole.set(c.role, c._count._all);

  const roles: OrgRole[] = [OrgRole.OWNER, OrgRole.ADMIN, OrgRole.MEMBER];
  const resources = roles.map((role) => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    id: groupIdForRole(role),
    displayName: groupDisplayName(role),
    meta: {
      resourceType: 'Group',
      location: `/api/scim/v2/Groups/${groupIdForRole(role)}`,
    },
    // Don't expand `members` on the list endpoint — the SCIM convention
    // is to keep it skinny and let IdP pull /Groups/{id} for the full set.
    members: [],
    'urn:kitora:scim:1.0:tenant': {
      orgSlug: auth.orgSlug,
      memberCount: countByRole.get(role) ?? 0,
    },
  }));

  return scimJson(200, {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  });
}
