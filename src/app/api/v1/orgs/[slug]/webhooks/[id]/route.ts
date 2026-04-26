import { NextResponse } from 'next/server';

import { gateOrgApi } from '@/lib/api-org-gate';
import { prisma } from '@/lib/db';
import { apiLimiter } from '@/lib/rate-limit';
import { WEBHOOK_EVENTS_SET } from '@/lib/webhooks/events';
import { validateWebhookUrl } from '@/lib/webhooks/url-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0003 PR-1 — `PATCH /api/v1/orgs/{slug}/webhooks/{id}` (partial update)
 * and `DELETE` (cascades pending deliveries via FK).
 *
 * PATCH body accepts any subset of:
 *   - `url`           — re-validated through the SSRF guard
 *   - `description`   — string or null
 *   - `enabledEvents` — array, must be a subset of WEBHOOK_EVENTS
 *   - `disabledAt`    — ISO string to disable, `null` to re-enable
 */

interface PatchBody {
  url?: unknown;
  description?: unknown;
  enabledEvents?: unknown;
  disabledAt?: unknown;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const gate = await gateOrgApi({ request, orgSlug: slug });
  if (!gate.ok) return errResp(gate.status);

  const { success, remaining, reset } = await apiLimiter.limit(`api:${gate.principal.tokenId}`);
  if (!success) return rateLimited(reset);

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }

  const data: {
    url?: string;
    description?: string | null;
    enabledEvents?: string[];
    disabledAt?: Date | null;
  } = {};

  if (body.url !== undefined) {
    if (typeof body.url !== 'string')
      return NextResponse.json({ error: 'invalid-url' }, { status: 400 });
    const verdict = validateWebhookUrl(body.url);
    if (!verdict.ok) return NextResponse.json({ error: verdict.reason }, { status: 400 });
    data.url = verdict.url.toString();
  }

  if (body.description !== undefined) {
    if (body.description === null) data.description = null;
    else if (typeof body.description === 'string')
      data.description = body.description.slice(0, 200);
    else return NextResponse.json({ error: 'invalid-description' }, { status: 400 });
  }

  if (body.enabledEvents !== undefined) {
    if (!Array.isArray(body.enabledEvents)) {
      return NextResponse.json({ error: 'invalid-events' }, { status: 400 });
    }
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

  if (body.disabledAt !== undefined) {
    if (body.disabledAt === null) data.disabledAt = null;
    else if (typeof body.disabledAt === 'string') {
      const d = new Date(body.disabledAt);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: 'invalid-disabledAt' }, { status: 400 });
      }
      data.disabledAt = d;
    } else {
      return NextResponse.json({ error: 'invalid-disabledAt' }, { status: 400 });
    }
  }

  const result = await prisma.webhookEndpoint.updateMany({
    where: { id, orgId: gate.orgId },
    data,
  });
  if (result.count === 0) return errResp(404);

  return NextResponse.json({ ok: true }, { headers: rateHeaders(remaining, reset) });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const gate = await gateOrgApi({ request, orgSlug: slug });
  if (!gate.ok) return errResp(gate.status);

  const { success, remaining, reset } = await apiLimiter.limit(`api:${gate.principal.tokenId}`);
  if (!success) return rateLimited(reset);

  const result = await prisma.webhookEndpoint.deleteMany({
    where: { id, orgId: gate.orgId },
  });
  if (result.count === 0) return errResp(404);

  return NextResponse.json({ ok: true }, { headers: rateHeaders(remaining, reset) });
}

function errResp(status: 401 | 403 | 404 | 400) {
  const map = {
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not-found',
    400: 'bad-request',
  } as const;
  return NextResponse.json({ error: map[status] }, { status });
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
