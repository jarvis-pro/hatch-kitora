import { NextResponse } from 'next/server';

import { gateOrgApi } from '@/lib/api-org-gate';
import { prisma } from '@/lib/db';
import { apiLimiter } from '@/lib/rate-limit';
import { generateScimToken } from '@/lib/sso/secret';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-1 — `POST /api/v1/orgs/{slug}/identity-providers/{id}/rotate-scim-token`
 *
 * Returns the plaintext SCIM token exactly once. The previous token is
 * invalidated the moment the row commits — no overlap window. Callers
 * should atomically swap their IdP-side configuration the moment they
 * receive the response.
 *
 * The first call also flips `scimEnabled = true`; rotating later keeps it
 * enabled. To turn SCIM off, hit the regular PATCH endpoint with
 * `scimEnabled: false`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const gate = await gateOrgApi({ request, orgSlug: slug });
  if (!gate.ok) {
    const map = { 401: 'unauthorized', 403: 'forbidden', 404: 'not-found' } as const;
    return NextResponse.json({ error: map[gate.status] }, { status: gate.status });
  }

  const { success, remaining, reset } = await apiLimiter.limit(`api:${gate.principal.tokenId}`);
  if (!success) {
    return NextResponse.json(
      { error: 'rate-limited' },
      {
        status: 429,
        headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(reset) },
      },
    );
  }

  const existing = await prisma.identityProvider.findFirst({
    where: { id, orgId: gate.orgId },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  const fresh = generateScimToken();
  await prisma.identityProvider.update({
    where: { id: existing.id },
    data: {
      scimTokenHash: fresh.hash,
      scimTokenPrefix: fresh.prefix,
      scimEnabled: true,
    },
  });

  return NextResponse.json(
    { token: fresh.plain, tokenPrefix: fresh.prefix },
    {
      headers: {
        'X-RateLimit-Remaining': String(remaining),
        'X-RateLimit-Reset': String(reset),
      },
    },
  );
}
