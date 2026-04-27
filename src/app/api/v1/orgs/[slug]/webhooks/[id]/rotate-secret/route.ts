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
 * 明文密钥仅返回一次。行提交后旧密钥立即失效 ——
 * 刻意设计为无重叠窗口期。
 * 调用方应在收到响应后立即原子性地更新配置。
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
  // 预先做存在性检查，以便在变更前获取 HKDF 所需的 id。
  const existing = await prisma.webhookEndpoint.findFirst({
    where: { id, orgId: gate.orgId },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }
  await prisma.webhookEndpoint.update({
    where: { id: existing.id },
    data: {
      secretHash: fresh.hash,
      secretPrefix: fresh.prefix,
      encSecret: fresh.encryptForEndpoint(existing.id),
    },
  });

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
