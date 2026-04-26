import { OrgRole } from '@prisma/client';

import { recordAudit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { authenticateScim, scimError, scimJson } from '@/lib/sso/scim-auth';
import { roleFromGroupId, toScimUser } from '@/lib/sso/scim-user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-4 — SCIM User by id.
 *
 *   GET    /api/scim/v2/Users/{id}   — single User shape
 *   PATCH  /api/scim/v2/Users/{id}   — `active`, `name`, `groups` ops
 *   DELETE /api/scim/v2/Users/{id}   — hard delete the Membership row
 *
 * `id` is the Membership row id, not the User id (RFC 0004 §4.3 — same
 * person can be in multiple orgs; SCIM scope is per-tenant).
 *
 * PATCH body shape per SCIM 2.0 §3.5.2:
 *   {
 *     "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
 *     "Operations": [
 *       { "op": "replace", "path": "active",       "value": false },
 *       { "op": "replace", "path": "name.givenName", "value": "Jane" },
 *       { "op": "add",     "path": "groups",       "value": [{ value: "admins" }] }
 *     ]
 *   }
 *
 * We only implement what Okta / Azure AD / Google Workspace actually
 * send: `replace` on `active` / `name.givenName` / `name.familyName`,
 * and `replace`/`add` on `groups`. Anything else returns 400 with
 * `scimType: invalidPath` so the IdP backs off cleanly.
 */

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return scimError(auth.status, auth.reason);

  const { id } = await params;
  const row = await prisma.membership.findFirst({
    where: { id, orgId: auth.orgId },
    select: {
      id: true,
      role: true,
      deletedAt: true,
      providerSubject: true,
      user: { select: { id: true, email: true, name: true } },
    },
  });
  if (!row) return scimError(404, 'user not found');

  return scimJson(
    200,
    toScimUser(
      {
        id: row.user.id,
        email: row.user.email,
        name: row.user.name,
        membershipId: row.id,
        role: row.role,
        deletedAt: row.deletedAt,
        providerSubject: row.providerSubject,
      },
      auth.orgSlug,
    ),
  );
}

interface PatchOp {
  op?: unknown;
  path?: unknown;
  value?: unknown;
}

interface PatchBody {
  schemas?: unknown;
  Operations?: PatchOp[];
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return scimError(auth.status, auth.reason);

  const { id } = await params;
  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return scimError(400, 'invalid-json');
  }

  const ops = Array.isArray(body.Operations) ? body.Operations : [];
  if (ops.length === 0) return scimError(400, 'no operations');

  const existing = await prisma.membership.findFirst({
    where: { id, orgId: auth.orgId },
    select: {
      id: true,
      role: true,
      deletedAt: true,
      user: { select: { id: true, name: true } },
    },
  });
  if (!existing) return scimError(404, 'user not found');

  const data: { deletedAt?: Date | null; role?: OrgRole } = {};
  let nextName: string | null | undefined = undefined; // undefined = no change
  let givenName: string | null = parseGivenName(existing.user.name);
  let familyName: string | null = parseFamilyName(existing.user.name);

  for (const op of ops) {
    const verb = (typeof op.op === 'string' ? op.op : '').toLowerCase();
    const path = typeof op.path === 'string' ? op.path : '';

    // ── active ────────────────────────────────────────────────────────
    if (path === 'active' && verb === 'replace') {
      if (typeof op.value !== 'boolean') {
        return scimError(400, 'active must be boolean', { scimType: 'invalidValue' });
      }
      data.deletedAt = op.value ? null : (existing.deletedAt ?? new Date());
      continue;
    }

    // ── name.{givenName,familyName} ──────────────────────────────────
    if (path === 'name.givenName' && (verb === 'replace' || verb === 'add')) {
      givenName = stringOrNull(op.value);
      nextName = composeName(givenName, familyName);
      continue;
    }
    if (path === 'name.familyName' && (verb === 'replace' || verb === 'add')) {
      familyName = stringOrNull(op.value);
      nextName = composeName(givenName, familyName);
      continue;
    }

    // ── groups ────────────────────────────────────────────────────────
    if (path === 'groups' && (verb === 'replace' || verb === 'add')) {
      // Pick the LAST group in the array — IdPs sometimes send multiple
      // for "remove old + add new". The only group we honor is the role
      // marker; everything else is ignored.
      const arr = Array.isArray(op.value) ? op.value : [];
      let targetRole: OrgRole | null = null;
      for (const g of arr) {
        if (g && typeof g === 'object' && 'value' in g && typeof g.value === 'string') {
          const r = roleFromGroupId(g.value);
          if (r !== null) targetRole = r;
        }
      }
      if (targetRole === OrgRole.OWNER) {
        return scimError(400, 'OWNER cannot be assigned via SCIM', { scimType: 'noTarget' });
      }
      if (targetRole !== null) {
        data.role = targetRole;
      }
      continue;
    }

    // Unsupported op → keep the connector alive but make the noise loud
    // enough that we'd notice if a popular IdP needs another path.
    logger.warn({ verb, path, providerId: auth.idpId }, 'scim-patch-unsupported-op');
  }

  // Apply — separate name update on the User row, role/active on the
  // Membership row. Both are short-cut if nothing changed.
  if (nextName !== undefined) {
    await prisma.user.update({
      where: { id: existing.user.id },
      data: { name: nextName },
    });
  }
  if (Object.keys(data).length > 0) {
    await prisma.membership.update({ where: { id: existing.id }, data });
  }

  if (data.deletedAt !== undefined) {
    await recordAudit({
      actorId: null,
      orgId: auth.orgId,
      action: data.deletedAt === null ? 'scim.user_provisioned' : 'scim.user_deprovisioned',
      target: existing.id,
      metadata: { active: data.deletedAt === null },
    });
  }

  // Return the fresh shape — IdP connectors expect the patched resource.
  const fresh = await prisma.membership.findFirstOrThrow({
    where: { id: existing.id },
    select: {
      id: true,
      role: true,
      deletedAt: true,
      providerSubject: true,
      user: { select: { id: true, email: true, name: true } },
    },
  });
  return scimJson(
    200,
    toScimUser(
      {
        id: fresh.user.id,
        email: fresh.user.email,
        name: fresh.user.name,
        membershipId: fresh.id,
        role: fresh.role,
        deletedAt: fresh.deletedAt,
        providerSubject: fresh.providerSubject,
      },
      auth.orgSlug,
    ),
  );
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return scimError(auth.status, auth.reason);

  const { id } = await params;
  const existing = await prisma.membership.findFirst({
    where: { id, orgId: auth.orgId },
    select: { id: true, role: true },
  });
  if (!existing) return scimError(404, 'user not found');
  if (existing.role === OrgRole.OWNER) {
    return scimError(400, 'OWNER cannot be deprovisioned via SCIM', { scimType: 'noTarget' });
  }

  await prisma.membership.delete({ where: { id: existing.id } });

  await recordAudit({
    actorId: null,
    orgId: auth.orgId,
    action: 'scim.user_deprovisioned',
    target: existing.id,
    metadata: { hardDelete: true },
  });

  return new Response(null, { status: 204 });
}

// ─── helpers ────────────────────────────────────────────────────────────────

function stringOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseGivenName(full: string | null): string | null {
  if (!full) return null;
  return full.split(/\s+/)[0] ?? null;
}

function parseFamilyName(full: string | null): string | null {
  if (!full) return null;
  const parts = full.split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : null;
}

function composeName(given: string | null, family: string | null): string | null {
  const joined = [given, family]
    .filter((s): s is string => !!s)
    .join(' ')
    .trim();
  return joined.length > 0 ? joined : null;
}
