// 将 `(User, Membership)` 对形状化为 SCIM 2.0 User
// 资源表示的助手。纯模块 — 没有 'server-only' 所以路由
// 处理程序 + 测试都可以导入。

import { OrgRole } from '@prisma/client';

export interface ScimUserInput {
  id: string;
  email: string;
  name: string | null;
  /** Membership 级别的字段。 */
  membershipId: string;
  role: OrgRole;
  deletedAt: Date | null;
  providerSubject: string | null;
}

/**
 * 将 User+Membership 行投影到 SCIM `urn:…:User` 形状。
 * SCIM `id` 是**成员资格** id — 不是用户 id — 因为 SCIM
 * 按 IdP/租户范围，相同 User 行可以在多个 org 中有成员资格。
 * 使用成员资格 id 是 IdP 期望的：当 IT 在 Okta 中从 Kitora 应用
 * 删除用户时，SCIM DELETE 到达该 id，我们干净地仅删除那个 org
 * 的成员资格。
 */
export function toScimUser(row: ScimUserInput, orgSlug: string) {
  const [givenName, ...rest] = (row.name ?? '').split(/\s+/).filter(Boolean);
  const familyName = rest.join(' ').trim();
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: row.membershipId,
    userName: row.email,
    externalId: row.providerSubject ?? undefined,
    name: row.name
      ? {
          givenName: givenName ?? '',
          familyName: familyName || undefined,
        }
      : undefined,
    emails: [
      {
        value: row.email,
        primary: true,
      },
    ],
    active: row.deletedAt === null,
    groups: [
      {
        value: groupIdForRole(row.role),
        display: groupDisplayName(row.role),
        $ref: `/api/scim/v2/Groups/${groupIdForRole(row.role)}`,
      },
    ],
    meta: {
      resourceType: 'User',
      location: `/api/scim/v2/Users/${row.membershipId}`,
      // 我们不分别从 Membership.joinedAt 跟踪每行 mtime；
      // 大多数 IdP 接受这里未设置或过期的 `lastModified`。
      lastModified: undefined,
    },
    // Per-tenant 便利属性 — 不是标准 SCIM User 模式的部分
    // 但对 IdP 侧诊断有用。
    'urn:kitora:scim:1.0:tenant': { orgSlug },
  };
}

/**
 * 3 个静态 SCIM Groups 公开稳定 id — 我们使用角色枚举
 * 小写，以便 IT 操作者可以一眼识别。
 */
export function groupIdForRole(role: OrgRole): string {
  return role.toLowerCase();
}

export function groupDisplayName(role: OrgRole): 'Owners' | 'Admins' | 'Members' {
  if (role === OrgRole.OWNER) return 'Owners';
  if (role === OrgRole.ADMIN) return 'Admins';
  return 'Members';
}

export function roleFromGroupId(groupId: string): OrgRole | null {
  const normalized = groupId.toLowerCase();
  if (normalized === 'owner' || normalized === 'owners') return OrgRole.OWNER;
  if (normalized === 'admin' || normalized === 'admins') return OrgRole.ADMIN;
  if (normalized === 'member' || normalized === 'members') return OrgRole.MEMBER;
  return null;
}

/**
 * 解析 SCIM `userName eq "value"` 过滤器子句。其他一切在 v1 中
 * 不受支持 — 我们在路由处理程序中记录 + 400。
 */
export function parseUserNameEqFilter(filter: string): string | null {
  // 匹配：userName eq "value"   /   userName eq 'value'   /   externalId eq "value"
  const m = filter.match(/^(userName|externalId)\s+eq\s+(['"])(.+)\2$/i);
  return m ? m[3]! : null;
}

export function parseFilterField(filter: string): 'userName' | 'externalId' | null {
  const m = filter.match(/^(userName|externalId)\s+eq\s+/i);
  if (!m) return null;
  return m[1]!.toLowerCase() === 'externalid' ? 'externalId' : 'userName';
}
