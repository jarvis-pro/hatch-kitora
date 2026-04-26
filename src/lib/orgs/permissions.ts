import { OrgRole } from '@prisma/client';

/**
 * Org-internal permission matrix — see RFC-0001 §4.
 *
 * Platform `User.role = ADMIN` is intentionally NOT considered here; it's a
 * separate axis enforced via `requireAdmin` in `src/lib/admin/actions.ts`.
 * Mixing the two would make the audit story muddy, so we keep them apart.
 */

export type OrgAction =
  | 'org.view'
  | 'org.update' // rename / slug / image
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
