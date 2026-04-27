import { OrgRole } from '@prisma/client';

/**
 * Org 内部权限矩阵 — 见 RFC-0001 §4。
 *
 * Platform `User.role = ADMIN` 刻意不被考虑；它是一个
 * 单独的轴，通过 `src/lib/admin/actions.ts` 中的 `requireAdmin` 执行。
 * 混合两者会使审计故事浑浊，所以我们将它们分开。
 */

export type OrgAction =
  | 'org.view'
  | 'org.update' // 重命名 / slug / 图像
  | 'org.delete'
  | 'org.transfer_ownership'
  | 'member.invite'
  | 'member.remove'
  | 'member.update_role'
  | 'token.create'
  | 'token.revoke_others'
  | 'billing.manage';

const MATRIX: Record<OrgAction, readonly OrgRole[]> = {
  'org.view': [OrgRole.OWNER, OrgRole.ADMIN, OrgRole.MEMBER],
  'org.update': [OrgRole.OWNER, OrgRole.ADMIN],
  'org.delete': [OrgRole.OWNER],
  'org.transfer_ownership': [OrgRole.OWNER],
  'member.invite': [OrgRole.OWNER, OrgRole.ADMIN],
  'member.remove': [OrgRole.OWNER, OrgRole.ADMIN],
  'member.update_role': [OrgRole.OWNER, OrgRole.ADMIN],
  'token.create': [OrgRole.OWNER, OrgRole.ADMIN, OrgRole.MEMBER],
  'token.revoke_others': [OrgRole.OWNER, OrgRole.ADMIN],
  'billing.manage': [OrgRole.OWNER, OrgRole.ADMIN],
};

export function can(role: OrgRole, action: OrgAction): boolean {
  return MATRIX[action].includes(role);
}
