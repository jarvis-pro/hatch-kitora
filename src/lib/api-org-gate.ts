import 'server-only';

import { OrgRole } from '@prisma/client';

import { type ApiTokenPrincipal, authenticateBearer } from '@/lib/api-auth';
import { prisma } from '@/lib/db';

/**
 * RFC 0003 PR-1 — bearer-auth + org-membership gate for /api/v1/orgs/[slug]/*.
 *
 * Three checks in one helper because every webhook endpoint route does
 * the same thing:
 *
 *   1. Authenticate the Bearer token (delegates to `authenticateBearer`).
 *   2. Resolve the org by `slug` (404 if unknown).
 *   3. Confirm the *token's bound org* matches the requested slug AND
 *      that token's user has the required role (OWNER/ADMIN by default).
 *
 * The "token's bound org must match requested slug" rule is RFC 0001 §9
 * — one token, one org. Cross-org access requires a separate token.
 */

export type ApiOrgGateResult =
  | { ok: true; principal: ApiTokenPrincipal; orgId: string }
  | { ok: false; status: 401 | 403 | 404 };

interface Options {
  request: Request;
  orgSlug: string;
  /** Allowed roles. Defaults to [OWNER, ADMIN] — the typical "manager" gate. */
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

  // The token must be bound to *this* org. RFC 0001 §9.
  if (principal.orgId !== org.id) return { ok: false, status: 403 };

  const membership = await prisma.membership.findFirst({
    where: { userId: principal.userId, orgId: org.id, role: { in: [...allowed] } },
    select: { id: true },
  });
  if (!membership) return { ok: false, status: 403 };

  return { ok: true, principal, orgId: org.id };
}
