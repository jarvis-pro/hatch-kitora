import { NextResponse } from 'next/server';

import { authenticateBearer } from '@/lib/api-auth';
import { getCurrentBilling } from '@/lib/billing/current';
import { prisma } from '@/lib/db';
import { apiLimiter } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public REST endpoint — `GET /api/v1/me`
 *
 * Demonstrates the personal API token flow end-to-end:
 *   curl -H "Authorization: Bearer kitora_..." https://app.kitora.com/api/v1/me
 *
 * Returns the authenticated user's profile + current plan. 401 on missing /
 * invalid / revoked / expired token; 429 on rate-limit hit.
 */
export async function GET(request: Request) {
  const principal = await authenticateBearer(request);
  if (!principal) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Per-token limiter — much fairer than per-IP for server-to-server callers.
  const { success, remaining, reset } = await apiLimiter.limit(`api:${principal.tokenId}`);
  if (!success) {
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

  const [user, billing] = await Promise.all([
    prisma.user.findUnique({
      where: { id: principal.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        emailVerified: true,
        createdAt: true,
      },
    }),
    getCurrentBilling(principal.userId),
  ]);

  if (!user) {
    // The token outlived its owner — defensive 401 rather than 500.
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  return NextResponse.json(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role.toLowerCase(),
      emailVerified: !!user.emailVerified,
      createdAt: user.createdAt.toISOString(),
      plan: {
        id: billing.plan.id,
        name: billing.plan.name,
        status: billing.subscription?.status?.toLowerCase() ?? 'free',
        currentPeriodEnd: billing.subscription?.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: billing.subscription?.cancelAtPeriodEnd ?? false,
      },
    },
    {
      headers: {
        'X-RateLimit-Remaining': String(remaining),
        'X-RateLimit-Reset': String(reset),
      },
    },
  );
}
