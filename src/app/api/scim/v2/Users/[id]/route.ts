import { OrgRole } from '@prisma/client';

import { recordAudit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { authenticateScim, scimError, scimJson } from '@/lib/sso/scim-auth';
import { roleFromGroupId, toScimUser } from '@/lib/sso/scim-user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-4 — 按 id 的 SCIM 用户。
 *
 *   GET    /api/scim/v2/Users/{id}   — 单个用户形状
 *   PATCH  /api/scim/v2/Users/{id}   — `active`、`name`、`groups` 操作
 *   DELETE /api/scim/v2/Users/{id}   — 硬删除 Membership 行
 *
 * `id` 是 Membership 行 id，不是 User id（RFC 0004 §4.3 —— 同一个人可以在多个组织；
 * SCIM 范围是按租户）。
 *
 * PATCH body 形状遵循 SCIM 2.0 §3.5.2：
 *   {
 *     "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
 *     "Operations": [
 *       { "op": "replace", "path": "active",       "value": false },
 *       { "op": "replace", "path": "name.givenName", "value": "Jane" },
 *       { "op": "add",     "path": "groups",       "value": [{ value: "admins" }] }
 *     ]
 *   }
 *
 * 我们只实现 Okta / Azure AD / Google Workspace 实际会发送的操作：
 * `replace` 作用于 `active` / `name.givenName` / `name.familyName`，
 * `replace`/`add` 作用于 `groups`。其余操作返回 400 并附
 * `scimType: invalidPath`，让 IdP 干净地退出。
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

    // ── 活跃状态 ──────────────────────────────────────────────────────────
    if (path === 'active' && verb === 'replace') {
      if (typeof op.value !== 'boolean') {
        return scimError(400, 'active must be boolean', { scimType: 'invalidValue' });
      }
      data.deletedAt = op.value ? null : (existing.deletedAt ?? new Date());
      continue;
    }

    // ── 名称.{givenName,familyName} ────────────────────────────────────
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

    // ── 组 ──────────────────────────────────────────────────────────────
    if (path === 'groups' && (verb === 'replace' || verb === 'add')) {
      // 取数组中最后一个组 —— IdP 有时会发送多个（如"删除旧组 + 添加新组"）。
      // 我们只处理角色标记组，其余忽略。
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

    // 不支持的操作 → 保持连接器存活，但记录足够详细的日志，
    // 以便在主流 IdP 需要其他路径时能及时察觉。
    logger.warn({ verb, path, providerId: auth.idpId }, 'scim-patch-unsupported-op');
  }

  // 应用变更 —— User 行单独更新 name，Membership 行更新 role/active。
  // 如果没有实际变化，则均走短路跳过。
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

  // 返回最新数据 —— IdP 连接器期望得到已 patch 后的资源。
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

// ─── 帮助函数 ──────────────────────────────────────────────────────────────

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
