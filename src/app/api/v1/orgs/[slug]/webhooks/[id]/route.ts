import { NextResponse } from 'next/server';

import { gateOrgApi } from '@/lib/api-org-gate';
import { prisma } from '@/lib/db';
import { apiLimiter } from '@/lib/rate-limit';
import { WEBHOOK_EVENTS_SET } from '@/services/webhooks/events';
import { validateWebhookUrl } from '@/services/webhooks/url-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0003 PR-1 — Webhook 端点部分更新和删除
 *
 * 支持 `PATCH /api/v1/orgs/{slug}/webhooks/{id}` 部分更新
 * 和 `DELETE /api/v1/orgs/{slug}/webhooks/{id}` 删除（级联删除待派送的事件）。
 *
 * PATCH body 可包含以下任意字段子集：
 *   - `url` (string, 可选): 新的 Webhook 目标 URL，需通过 SSRF 防护验证
 *   - `description` (string|null, 可选): 端点描述，最多 200 字符，可设为 null
 *   - `enabledEvents` (string[], 可选): 启用的事件类型数组，必须是 WEBHOOK_EVENTS 的子集
 *   - `disabledAt` (ISO8601|null, 可选): ISO8601 时间戳以禁用端点，设为 null 重新启用
 */

interface PatchBody {
  url?: unknown;
  description?: unknown;
  enabledEvents?: unknown;
  disabledAt?: unknown;
}

/**
 * PATCH /api/v1/orgs/{slug}/webhooks/{id}
 *
 * 部分更新 Webhook 端点配置。
 *
 * @param request - 请求对象，body 为 PatchBody（上述所有字段均可选）
 * @param params - 路径参数 { slug: string; id: string }
 *
 * 鉴权：需要有效的组织 API Token，且 Token 对应的组织必须拥有该 Webhook 端点。
 * 速率限制：基于 API Token 的全局限流。
 *
 * @returns 成功时返回 { ok: true } (200)，包含 X-RateLimit-Remaining 和 X-RateLimit-Reset 响应头；
 *          未认证返回 { error: 'unauthorized' } (401)；
 *          无权限返回 { error: 'forbidden' } (403)；
 *          端点不存在返回 { error: 'not-found' } (404)；
 *          参数错误返回对应错误信息 (400)；
 *          速率限制超出返回 { error: 'rate-limited' } (429)。
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  // 通过组织 API Token 鉴权并获取权限上下文
  const gate = await gateOrgApi({ request, orgSlug: slug });
  if (!gate.ok) return errResp(gate.status);

  // 检查 API Token 速率限制
  const { success, remaining, reset } = await apiLimiter.limit(`api:${gate.principal.tokenId}`);
  if (!success) return rateLimited(reset);

  // 解析请求 body
  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }

  // 构建更新数据对象，仅包含被提供的字段
  const data: {
    url?: string;
    description?: string | null;
    enabledEvents?: string[];
    disabledAt?: Date | null;
  } = {};

  // 验证和更新 URL 字段
  if (body.url !== undefined) {
    if (typeof body.url !== 'string')
      return NextResponse.json({ error: 'invalid-url' }, { status: 400 });
    // 通过 SSRF 防护验证新 URL
    const verdict = validateWebhookUrl(body.url);
    if (!verdict.ok) return NextResponse.json({ error: verdict.reason }, { status: 400 });
    data.url = verdict.url.toString();
  }

  // 验证和更新描述字段（最多 200 字符）
  if (body.description !== undefined) {
    if (body.description === null) data.description = null;
    else if (typeof body.description === 'string')
      data.description = body.description.slice(0, 200);
    else return NextResponse.json({ error: 'invalid-description' }, { status: 400 });
  }

  // 验证和更新启用的事件列表
  if (body.enabledEvents !== undefined) {
    if (!Array.isArray(body.enabledEvents)) {
      return NextResponse.json({ error: 'invalid-events' }, { status: 400 });
    }
    // 检查每个事件是否在允许的事件集中
    for (const e of body.enabledEvents) {
      if (typeof e !== 'string' || !WEBHOOK_EVENTS_SET.has(e)) {
        return NextResponse.json(
          { error: 'unknown-event', event: typeof e === 'string' ? e : null },
          { status: 400 },
        );
      }
    }
    data.enabledEvents = body.enabledEvents as string[];
  }

  // 验证和更新禁用时间戳
  if (body.disabledAt !== undefined) {
    if (body.disabledAt === null) data.disabledAt = null;
    else if (typeof body.disabledAt === 'string') {
      // 尝试解析 ISO8601 时间戳
      const d = new Date(body.disabledAt);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: 'invalid-disabledAt' }, { status: 400 });
      }
      data.disabledAt = d;
    } else {
      return NextResponse.json({ error: 'invalid-disabledAt' }, { status: 400 });
    }
  }

  // 更新数据库中的 Webhook 端点
  const result = await prisma.webhookEndpoint.updateMany({
    where: { id, orgId: gate.orgId },
    data,
  });
  // 若无匹配的端点，说明 id 或 slug 无效
  if (result.count === 0) return errResp(404);

  return NextResponse.json({ ok: true }, { headers: rateHeaders(remaining, reset) });
}

/**
 * DELETE /api/v1/orgs/{slug}/webhooks/{id}
 *
 * 删除 Webhook 端点及其所有待派送的事件（通过外键级联删除）。
 *
 * @param request - 请求对象，无 body
 * @param params - 路径参数 { slug: string; id: string }
 *
 * 鉴权：需要有效的组织 API Token，且 Token 对应的组织必须拥有该 Webhook 端点。
 * 速率限制：基于 API Token 的全局限流。
 *
 * @returns 成功时返回 { ok: true } (200)，包含 X-RateLimit-Remaining 和 X-RateLimit-Reset 响应头；
 *          未认证返回 { error: 'unauthorized' } (401)；
 *          无权限返回 { error: 'forbidden' } (403)；
 *          端点不存在返回 { error: 'not-found' } (404)；
 *          速率限制超出返回 { error: 'rate-limited' } (429)。
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  // 通过组织 API Token 鉴权并获取权限上下文
  const gate = await gateOrgApi({ request, orgSlug: slug });
  if (!gate.ok) return errResp(gate.status);

  // 检查 API Token 速率限制
  const { success, remaining, reset } = await apiLimiter.limit(`api:${gate.principal.tokenId}`);
  if (!success) return rateLimited(reset);

  // 删除指定的 Webhook 端点（级联删除其待派送事件）
  const result = await prisma.webhookEndpoint.deleteMany({
    where: { id, orgId: gate.orgId },
  });
  // 若无匹配的端点，说明 id 或 slug 无效
  if (result.count === 0) return errResp(404);

  return NextResponse.json({ ok: true }, { headers: rateHeaders(remaining, reset) });
}

/**
 * 根据 HTTP 状态码返回标准错误响应。
 * @param status - HTTP 状态码（401、403、404、400）
 * @returns NextResponse JSON 错误响应
 */
function errResp(status: 401 | 403 | 404 | 400) {
  const map = {
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not-found',
    400: 'bad-request',
  } as const;
  return NextResponse.json({ error: map[status] }, { status });
}

/**
 * 返回速率限制 (429) 响应，包含重置时间戳。
 * @param reset - Unix 时间戳（毫秒），表示限制重置的时刻
 * @returns NextResponse 429 响应，包含 X-RateLimit-Remaining 和 X-RateLimit-Reset 响应头
 */
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

/**
 * 构建速率限制响应头对象。
 * @param remaining - 当前剩余的请求配额
 * @param reset - Unix 时间戳（毫秒），表示限制重置的时刻
 * @returns 包含 X-RateLimit-Remaining 和 X-RateLimit-Reset 的响应头对象
 */
function rateHeaders(remaining: number, reset: number): Record<string, string> {
  return {
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(reset),
  };
}
