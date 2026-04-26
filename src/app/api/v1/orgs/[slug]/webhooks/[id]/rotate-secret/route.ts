import { NextResponse } from 'next/server';

import { gateOrgApi } from '@/lib/api-org-gate';
import { prisma } from '@/lib/db';
import { apiLimiter } from '@/lib/rate-limit';
import { generateWebhookSecret } from '@/lib/webhooks/secret';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0003 PR-1 — `POST /api/v1/orgs/{slug}/webhooks/{id}/rotate-secret`
 *
 * Returns the plaintext secret exactly once. The old secret is invalidated
 * the moment the row commits — there's intentionally no overlap window.
 * Callers should plan to atomically swap their config the moment they
 * receive the response.
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

  const fresh = generateWebhookSecret();
  const result = await prisma.webhookEndpoint.updateMany({
    where: { id, orgId: gate.orgId },
    data: { secretHash: fresh.hash, secretPrefix: fresh.prefix },
  });
  if (result.count === 0) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  return NextResponse.json(
    { secret: fresh.plain, secretPrefix: fresh.prefix },
    {
      headers: {
        'X-RateLimit-Remaining': String(remaining),
        'X-RateLimit-Reset': String(reset),
      },
    },
  );
}
