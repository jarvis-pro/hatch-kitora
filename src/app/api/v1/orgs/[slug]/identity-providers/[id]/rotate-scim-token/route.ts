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
 * 恰好返回一次纯文本 SCIM 令牌。前一个令牌在行提交时立即失效 —
 * 没有重叠窗口。调用者应该在收到响应的那一刻原子性地交换其 IdP 端配置。
 *
 * 第一个调用也会翻转 `scimEnabled = true`；之后轮换保持它启用。
 * 要关闭 SCIM，使用 `scimEnabled: false` 访问常规 PATCH 端点。
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
