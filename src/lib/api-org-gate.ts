import 'server-only';

import { OrgRole } from '@prisma/client';

import { type ApiTokenPrincipal, authenticateBearer } from '@/lib/api-auth';
import { prisma } from '@/lib/db';
import { findActiveMembership } from '@/lib/orgs/queries';

/**
 * RFC 0003 PR-1 — 对 /api/v1/orgs/[slug]/* 的持有者认证 + org 成员资格门控。
 *
 * 三个检查在一个帮助程序中，因为每个 webhook 端点路由执行相同操作：
 *
 *   1. 认证持有者令牌（委托给 `authenticateBearer`）。
 *   2. 通过 `slug` 解析 org（未知则 404）。
 *   3. 确认*令牌的绑定 org*与请求的 slug 匹配，且该令牌的用户具有所需角色
 *      （默认 OWNER/ADMIN）。
 *
 * "令牌的绑定 org 必须与请求的 slug 匹配"规则是 RFC 0001 §9
 * — 一个令牌，一个 org。跨 org 访问需要单独的令牌。
 */

export type ApiOrgGateResult =
  | { ok: true; principal: ApiTokenPrincipal; orgId: string }
  | { ok: false; status: 401 | 403 | 404 };

interface Options {
  request: Request;
  orgSlug: string;
  /** 允许的角色。默认为 [OWNER, ADMIN] — 典型的"经理"门控。 */
  roles?: readonly OrgRole[];
}

export async function gateOrgApi(opts: Options): Promise<ApiOrgGateResult> {
  const principal = await authenticateBearer(opts.request);
  if (!principal) return { ok: false, status: 401 };

  const allowed = opts.roles ?? [OrgRole.OWNER, OrgRole.ADMIN];

  const org = await prisma.organization.findUnique({
    where: { slug: opts.orgSlug },
    select: { id: true },
  });
  if (!org) return { ok: false, status: 404 };

  // 令牌必须绑定到*这个* org。RFC 0001 §9。
  if (principal.orgId !== org.id) return { ok: false, status: 403 };

  // 软删除（SCIM `active: false`）的成员当然不算「在 org 里活跃」—— 走
  // findActiveMembership 自动过滤 `deletedAt: null`，避免被停用的账号继续访问 API。
  const membership = await findActiveMembership({
    where: { userId: principal.userId, orgId: org.id, role: { in: [...allowed] } },
    select: { id: true },
  });
  if (!membership) return { ok: false, status: 403 };

  return { ok: true, principal, orgId: org.id };
}
