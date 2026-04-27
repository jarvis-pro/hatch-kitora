import { NextResponse } from 'next/server';

import { gateOrgApi } from '@/lib/api-org-gate';
import { prisma } from '@/lib/db';
import { apiLimiter } from '@/lib/rate-limit';
import { WEBHOOK_EVENTS_SET } from '@/lib/webhooks/events';
import { generateWebhookSecret } from '@/lib/webhooks/secret';
import { validateWebhookUrl } from '@/lib/webhooks/url-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0003 PR-1 — `GET /api/v1/orgs/{slug}/webhooks` 和 `POST` 创建。
 *
 *   curl -H "Authorization: Bearer kitora_..." \
 *        https://app.kitora.com/api/v1/orgs/acme/webhooks
 *
 *   curl -X POST -H "Authorization: Bearer kitora_..." \
 *        -H "Content-Type: application/json" \
 *        -d '{"url":"https://example.com/hooks","enabledEvents":["subscription.created"]}' \
 *        https://app.kitora.com/api/v1/orgs/acme/webhooks
 *
 * Token 必须绑定到指定的组织（RFC 0001 §9），并属于一个拥有 OWNER 或 ADMIN 角色的用户。
 * POST 返回明文密钥恰好一次。
 */

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const gate = await gateOrgApi({ request, orgSlug: slug });
  if (!gate.ok) {
    return NextResponse.json({ error: errorCode(gate.status) }, { status: gate.status });
  }

  const { success, remaining, reset } = await apiLimiter.limit(`api:${gate.principal.tokenId}`);
  if (!success) return rateLimited(reset);

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { orgId: gate.orgId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      url: true,
      description: true,
      enabledEvents: true,
      secretPrefix: true,
      disabledAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json(
    {
      data: endpoints.map((e) => ({
        id: e.id,
        url: e.url,
        description: e.description,
        enabledEvents: e.enabledEvents,
        secretPrefix: e.secretPrefix,
        disabledAt: e.disabledAt?.toISOString() ?? null,
        createdAt: e.createdAt.toISOString(),
      })),
    },
    {
      headers: rateHeaders(remaining, reset),
    },
  );
}

interface CreateBody {
  url?: unknown;
  description?: unknown;
  enabledEvents?: unknown;
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const gate = await gateOrgApi({ request, orgSlug: slug });
  if (!gate.ok) {
    return NextResponse.json({ error: errorCode(gate.status) }, { status: gate.status });
  }

  const { success, remaining, reset } = await apiLimiter.limit(`api:${gate.principal.tokenId}`);
  if (!success) return rateLimited(reset);

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }
  if (typeof body.url !== 'string' || body.url.length === 0) {
    return NextResponse.json({ error: 'invalid-url' }, { status: 400 });
  }
  const verdict = validateWebhookUrl(body.url);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.reason }, { status: 400 });
  }

  const events = Array.isArray(body.enabledEvents) ? body.enabledEvents : [];
  for (const e of events) {
    if (typeof e !== 'string' || !WEBHOOK_EVENTS_SET.has(e)) {
      return NextResponse.json(
        { error: 'unknown-event', event: typeof e === 'string' ? e : null },
        { status: 400 },
      );
    }
  }
  const description =
    typeof body.description === 'string' && body.description.length > 0
      ? body.description.slice(0, 200)
      : null;

  const secret = generateWebhookSecret();
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      orgId: gate.orgId,
      url: verdict.url.toString(),
      description,
      enabledEvents: events as string[],
      secretHash: secret.hash,
      secretPrefix: secret.prefix,
    },
    select: {
      id: true,
      url: true,
      description: true,
      enabledEvents: true,
      secretPrefix: true,
      disabledAt: true,
      createdAt: true,
    },
  });
  // 加密密钥以行 id 为键，因此必须在行插入后才能写入。
  await prisma.webhookEndpoint.update({
    where: { id: endpoint.id },
    data: { encSecret: secret.encryptForEndpoint(endpoint.id) },
  });

  return NextResponse.json(
    {
      data: {
        id: endpoint.id,
        url: endpoint.url,
        description: endpoint.description,
        enabledEvents: endpoint.enabledEvents,
        secretPrefix: endpoint.secretPrefix,
        disabledAt: endpoint.disabledAt?.toISOString() ?? null,
        createdAt: endpoint.createdAt.toISOString(),
      },
      secret: secret.plain,
    },
    {
      status: 201,
      headers: rateHeaders(remaining, reset),
    },
  );
}

// ─── 与兄弟路由共享的小帮助函数 ────────────────────────────────────────────
//
// 保留在本文件中（未放入 `api-org-gate.ts`），因为这些只是简单的
// HTTP 形状工具函数，不值得额外引入一次。

function errorCode(status: number): string {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  return 'error';
}

function rateLimited(reset: number) {
  return NextResponse.json(
    { error: 'rate-limited' },
    {
      status: 429,
      headers: {
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(reset),
      },
    },
  );
}

function rateHeaders(remaining: number, reset: number): Record<string, string> {
  return {
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(reset),
  };
}
