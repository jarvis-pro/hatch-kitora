// Helpers for shaping a `(User, Membership)` pair into the SCIM 2.0 User
// resource representation. Pure module — no `'server-only'` so route
// handlers + tests can both import.

import { OrgRole } from '@prisma/client';

export interface ScimUserInput {
  id: string;
  email: string;
  name: string | null;
  /** Membership-level fields. */
  membershipId: string;
  role: OrgRole;
  deletedAt: Date | null;
  providerSubject: string | null;
}

/**
 * Project a User+Membership row into the SCIM `urn:…:User` shape. The
 * SCIM `id` is the **membership** id — not the user id — because SCIM is
 * scoped per-IdP / tenant, and the same User row can have memberships
 * across multiple orgs. Using membership id is what an IdP expects: when
 * IT removes the user from the Kitora app in Okta, SCIM DELETE arrives
 * with that id and we cleanly drop only that org's membership.
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
      // We don't track per-row mtime separately from Membership.joinedAt;
      // most IdPs accept either an unset or stale `lastModified` here.
      lastModified: undefined,
    },
    // Per-tenant convenience attributes — not part of the standard SCIM
    // User schema but useful for IdP-side diagnostics.
    'urn:kitora:scim:1.0:tenant': { orgSlug },
  };
}

/**
 * The 3 static SCIM Groups expose stable ids — we use the role enum
 * lowercased so an IT operator can spot them at a glance.
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
 * Parse a SCIM `userName eq "value"` filter clause. Anything else is
 * unsupported in v1 — we log + 400 in the route handler.
 */
export function parseUserNameEqFilter(filter: string): string | null {
  // Match: userName eq "value"   /   userName eq 'value'   /   externalId eq "value"
  const m = filter.match(/^(userName|externalId)\s+eq\s+(['"])(.+)\2$/i);
  return m ? m[3]! : null;
}

export function parseFilterField(filter: string): 'userName' | 'externalId' | null {
  const m = filter.match(/^(userName|externalId)\s+eq\s+/i);
  if (!m) return null;
  return m[1]!.toLowerCase() === 'externalid' ? 'externalId' : 'userName';
}
