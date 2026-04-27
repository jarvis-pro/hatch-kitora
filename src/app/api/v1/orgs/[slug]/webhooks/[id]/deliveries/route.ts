import { NextResponse } from 'next/server';

import { gateOrgApi } from '@/lib/api-org-gate';
import { prisma } from '@/lib/db';
import { apiLimiter } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0003 PR-1 — `GET /api/v1/orgs/{slug}/webhooks/{id}/deliveries`
 *
 * Most-recent 50 deliveries for the endpoint. PR-1 doesn't yet generate
 * any rows (no cron consumer wired); the route exists so integrators can
 * lock against a stable shape from day one and so the UI page renders
 * empty state without 404'ing.
 */
export async function GET(
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

  // 确认端点属于该组织，避免过期 id 泄露空数组的数据形态。
  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id, orgId: gate.orgId },
    select: { id: true },
  });
  if (!endpoint) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  const deliveries = await prisma.webhookDelivery.findMany({
    where: { endpointId: id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      eventId: true,
      eventType: true,
      status: true,
      attempt: true,
      responseStatus: true,
      errorMessage: true,
      createdAt: true,
      completedAt: true,
    },
  });

  return NextResponse.json(
    {
      data: deliveries.map((d) => ({
        id: d.id,
        eventId: d.eventId,
        eventType: d.eventType,
        status: d.status,
        attempt: d.attempt,
        responseStatus: d.responseStatus,
        errorMessage: d.errorMessage,
        createdAt: d.createdAt.toISOString(),
        completedAt: d.completedAt?.toISOString() ?? null,
      })),
    },
    {
      headers: {
        'X-RateLimit-Remaining': String(remaining),
        'X-RateLimit-Reset': String(reset),
      },
    },
  );
}
