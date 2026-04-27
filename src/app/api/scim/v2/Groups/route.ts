import { OrgRole } from '@prisma/client';

import { prisma } from '@/lib/db';
import { authenticateScim, scimError, scimJson } from '@/lib/sso/scim-auth';
import { groupDisplayName, groupIdForRole } from '@/lib/sso/scim-user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-4 — SCIM 组列表。
 *
 * 我们为每个租户公开三个静态组：`Owners`、`Admins`、`Members`。
 * 它们不是真正的 Prisma 行 —— 它们是对 `Membership.role` 的投影。
 * IdP 连接器仍然期望发现组资源，所以我们在这里合成它们。
 *
 * IT 可以通过 PATCH 用户（首选）或通过 PATCH 组并使用
 * `add`/`remove` 成员操作（在 by-id 路由中处理）来更新角色。
 * OWNER 通过 SCIM 是只读的（RFC 0004 §4.4）。
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
    // 不在列表端点展开 `members` —— SCIM 约定是保持精简，
    // 让 IdP pull /Groups/{id} 来获取完整集合。
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
