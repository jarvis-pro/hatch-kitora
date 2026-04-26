// NOTE: deliberately *not* `'server-only'` here — every SCIM route + e2e
// suite consumes this. Transitive `@/lib/db` (prisma) gates accidental
// client bundling.
//
// SCIM Bearer authentication helper. Tokens are issued via
// `rotateScimTokenAction` (RFC 0004 PR-1) and live in
// `IdentityProvider.scimTokenHash` as `sha256(plaintext)`. We never store
// the plaintext; on every SCIM request the caller's `Authorization:
// Bearer scim_…` header is hashed and looked up against that index.
//
// Returns the resolved `(idpId, orgId)` so the route handler can scope
// reads + writes to the same tenant — a token issued for one org can
// never accidentally provision into another.

import { prisma } from '@/lib/db';
import { currentRegion } from '@/lib/region';
import { hashScimToken } from '@/lib/sso/secret';

export type ScimAuthResult =
  | { ok: true; idpId: string; orgId: string; orgSlug: string }
  | { ok: false; status: 401 | 403; reason: string };

export async function authenticateScim(request: Request): Promise<ScimAuthResult> {
  const auth = request.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return { ok: false, status: 401, reason: 'missing-bearer' };
  }
  const token = auth.slice('Bearer '.length).trim();
  if (!token.startsWith('scim_')) {
    return { ok: false, status: 401, reason: 'malformed-token' };
  }

  const hash = hashScimToken(token);
  const idp = await prisma.identityProvider.findUnique({
    where: { scimTokenHash: hash },
    select: {
      id: true,
      orgId: true,
      scimEnabled: true,
      organization: { select: { slug: true, region: true } },
    },
  });
  if (!idp) {
    return { ok: false, status: 401, reason: 'token-not-found' };
  }
  if (!idp.scimEnabled) {
    // Token was rotated to disable but not yet revoked? Refuse anyway —
    // the IT operator is responsible for rotating in their IdP.
    return { ok: false, status: 403, reason: 'scim-disabled' };
  }
  // RFC 0005 §5 — SCIM tokens are region-bound. The token hash lives in
  // the region's own DB, so reaching this point already implies same
  // region; we still cross-check against `currentRegion()` so a
  // misconfigured stack can't accept tokens it shouldn't.
  if (idp.organization.region !== currentRegion()) {
    return { ok: false, status: 401, reason: 'wrong-region' };
  }
  return { ok: true, idpId: idp.id, orgId: idp.orgId, orgSlug: idp.organization.slug };
}

/**
 * SCIM error envelope per RFC 7644 §3.12. The `scimType` field is
 * optional and only set on validation errors — everything else is a
 * naked `{ status, detail }`.
 */
export function scimError(status: number, detail: string, extra?: { scimType?: string }): Response {
  return Response.json(
    {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: String(status),
      detail,
      ...(extra?.scimType ? { scimType: extra.scimType } : {}),
    },
    { status, headers: { 'Content-Type': 'application/scim+json; charset=utf-8' } },
  );
}

/** SCIM 200/201 envelope with the right Content-Type. */
export function scimJson(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { 'Content-Type': 'application/scim+json; charset=utf-8' },
  });
}
