import { OrgRole } from '@prisma/client';

import { recordAudit } from '@/services/audit';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { authenticateScim, scimError, scimJson } from '@/services/sso/scim-auth';
import { groupDisplayName, groupIdForRole, roleFromGroupId } from '@/services/sso/scim-user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-4 — 按 id 的 SCIM 组。
 *
 *   GET   /api/scim/v2/Groups/{id}   — 具有扩展 `members[]` 的组
 *   PATCH /api/scim/v2/Groups/{id}   — 添加/删除用户 → 角色转换
 *
 * `id` 是 `owner` / `admin` / `member` 之一（不区分大小写）。 PATCH
 * 支持 SCIM 规范的"将成员添加到组" / "从组中删除成员"操作：
 *
 *   {
 *     "Operations": [
 *       { "op": "add",    "path": "members", "value": [{ "value": "<membershipId>" }] },
 *       { "op": "remove", "path": "members[value eq \"<membershipId>\"]" }
 *     ]
 *   }
 *
 * 将成员添加到 `admins` 组会将其 `Membership.role` 设为 `ADMIN`。
 * 从 `admins` 中删除成员会将他们降级回 `MEMBER`。
 * 同样的逻辑适用于 `owners`，除了 OWNER 通过 SCIM 是只读的（§4.4）。
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

    // SCIM 删除是带有筛选器的路径形式：members[value eq "<id>"]
    if (verb === 'remove') {
      const m = path.match(/^members\[value eq ['"](.+?)['"]\]$/);
      if (m && m[1]) removes.push(m[1]);
      continue;
    }

    logger.warn({ verb, path, providerId: auth.idpId }, 'scim-group-patch-unsupported-op');
  }

  // 升级：在每个添加的成员资格上设置 role = targetRole（按组织作用域）。
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

  // 降级：从 `admins` 中删除的任何人都回退到 MEMBER。从 `members` 中删除
  // 是无操作的（不能降级到 member 以下；如果 IT 想移除用户，应该 DELETE /Users/{id}）。
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

  // 重新获取并返回最新的组表示。
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
