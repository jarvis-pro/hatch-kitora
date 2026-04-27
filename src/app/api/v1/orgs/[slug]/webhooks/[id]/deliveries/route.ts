import { NextResponse } from 'next/server';

import { gateOrgApi } from '@/lib/api-org-gate';
import { prisma } from '@/lib/db';
import { apiLimiter } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0003 PR-1 — `GET /api/v1/orgs/{slug}/webhooks/{id}/deliveries`
 *
 * 端点的最近 50 次交付。PR-1 尚未生成任何行（没有连接 cron consumer）；
 * 该路由存在是为了让集成方从第一天就能锁定稳定的形状，以及 UI 页面能呈现
 * 空状态而不返回 404。
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

  // 确认端点属于该组织，避免过期 id 泄露空数组这样的数据形状。
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
