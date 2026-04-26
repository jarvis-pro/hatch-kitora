import { OrgRole } from '@prisma/client';

import { recordAudit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { authenticateScim, scimError, scimJson } from '@/lib/sso/scim-auth';
import { groupDisplayName, groupIdForRole, roleFromGroupId } from '@/lib/sso/scim-user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-4 — SCIM Group by id.
 *
 *   GET   /api/scim/v2/Groups/{id}   — group with expanded `members[]`
 *   PATCH /api/scim/v2/Groups/{id}   — add/remove user → role flip
 *
 * `id` is one of `owner` / `admin` / `member` (case-insensitive). PATCH
 * supports the SCIM canonical "add member to group" / "remove member from
 * group" ops:
 *
 *   {
 *     "Operations": [
 *       { "op": "add",    "path": "members", "value": [{ "value": "<membershipId>" }] },
 *       { "op": "remove", "path": "members[value eq \"<membershipId>\"]" }
 *     ]
 *   }
 *
 * Adding a member to the `admins` group sets their `Membership.role =
 * ADMIN`. Removing a member from `admins` demotes them back to `MEMBER`.
 * Same idea for `owners`, except OWNER is read-only via SCIM (§4.4).
 */

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return scimError(auth.status, auth.reason);

  const { id } = await params;
  const role = roleFromGroupId(id);
  if (role === null) return scimError(404, 'unknown group');

  const members = await prisma.membership.findMany({
    where: { orgId: auth.orgId, role, deletedAt: null },
    select: {
      id: true,
      user: { select: { email: true } },
    },
    orderBy: { joinedAt: 'asc' },
  });

  return scimJson(200, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    id: groupIdForRole(role),
    displayName: groupDisplayName(role),
    members: members.map((m) => ({
      value: m.id,
      display: m.user.email,
      $ref: `/api/scim/v2/Users/${m.id}`,
    })),
    meta: {
      resourceType: 'Group',
      location: `/api/scim/v2/Groups/${groupIdForRole(role)}`,
    },
  });
}

interface PatchOp {
  op?: unknown;
  path?: unknown;
  value?: unknown;
}

interface PatchBody {
  Operations?: PatchOp[];
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return scimError(auth.status, auth.reason);

  const { id } = await params;
  const targetRole = roleFromGroupId(id);
  if (targetRole === null) return scimError(404, 'unknown group');
  if (targetRole === OrgRole.OWNER) {
    return scimError(400, 'OWNER cannot be assigned via SCIM', { scimType: 'noTarget' });
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return scimError(400, 'invalid-json');
  }

  const ops = Array.isArray(body.Operations) ? body.Operations : [];
  if (ops.length === 0) return scimError(400, 'no operations');

  const adds: string[] = [];
  const removes: string[] = [];

  for (const op of ops) {
    const verb = (typeof op.op === 'string' ? op.op : '').toLowerCase();
    const path = typeof op.path === 'string' ? op.path : '';

    if (verb === 'add' && path === 'members') {
      const arr = Array.isArray(op.value) ? op.value : [];
      for (const v of arr) {
        if (v && typeof v === 'object' && 'value' in v && typeof v.value === 'string') {
          adds.push(v.value);
        }
      }
      continue;
    }

    // SCIM remove is a path-with-filter form: members[value eq "<id>"]
    if (verb === 'remove') {
      const m = path.match(/^members\[value eq ['"](.+?)['"]\]$/);
      if (m && m[1]) removes.push(m[1]);
      continue;
    }

    logger.warn({ verb, path, providerId: auth.idpId }, 'scim-group-patch-unsupported-op');
  }

  // Promote: set role = targetRole on each added membership (scoped to org).
  if (adds.length > 0) {
    const updated = await prisma.membership.updateMany({
      where: {
        id: { in: adds },
        orgId: auth.orgId,
        role: { not: OrgRole.OWNER }, // never overwrite OWNER
      },
      data: { role: targetRole, deletedAt: null },
    });
    if (updated.count > 0) {
      await recordAudit({
        actorId: null,
        orgId: auth.orgId,
        action: 'scim.user_provisioned',
        target: id, // group id
        metadata: { addedToRole: targetRole, count: updated.count, ids: adds },
      });
    }
  }

  // Demote: anyone removed from `admins` falls back to MEMBER. Removing
  // from `members` is a no-op (you can't demote below member; if IT
  // wants the user gone they should DELETE /Users/{id}).
  if (removes.length > 0 && targetRole === OrgRole.ADMIN) {
    const updated = await prisma.membership.updateMany({
      where: { id: { in: removes }, orgId: auth.orgId, role: OrgRole.ADMIN },
      data: { role: OrgRole.MEMBER },
    });
    if (updated.count > 0) {
      await recordAudit({
        actorId: null,
        orgId: auth.orgId,
        action: 'scim.user_deprovisioned',
        target: id,
        metadata: { demoted: true, count: updated.count, ids: removes },
      });
    }
  }

  // Re-fetch and return the fresh group representation.
  const members = await prisma.membership.findMany({
    where: { orgId: auth.orgId, role: targetRole, deletedAt: null },
    select: { id: true, user: { select: { email: true } } },
    orderBy: { joinedAt: 'asc' },
  });
  return scimJson(200, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
    id: groupIdForRole(targetRole),
    displayName: groupDisplayName(targetRole),
    members: members.map((m) => ({
      value: m.id,
      display: m.user.email,
      $ref: `/api/scim/v2/Users/${m.id}`,
    })),
    meta: {
      resourceType: 'Group',
      location: `/api/scim/v2/Groups/${groupIdForRole(targetRole)}`,
    },
  });
}
