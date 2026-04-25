import { NextResponse } from 'next/server';

import { authenticateBearer } from '@/lib/api-auth';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Prometheus-format metrics endpoint.
 *
 * Auth: requires a Bearer ApiToken whose owner has the ADMIN role. We don't
 * use a session cookie here so a Prometheus scraper / external monitor can
 * poll it without storing cookies.
 *
 *   curl -H "Authorization: Bearer kitora_..." https://app.kitora.com/api/metrics
 */
export async function GET(request: Request) {
  const principal = await authenticateBearer(request);
  if (!principal) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const owner = await prisma.user.findUnique({
    where: { id: principal.userId },
    select: { role: true },
  });
  if (owner?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [totalUsers, newUsersLast7d, activeSubs, trialingSubs, apiTokensActive, auditLogTotal] =
    await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      prisma.subscription.count({ where: { status: 'ACTIVE' } }),
      prisma.subscription.count({ where: { status: 'TRIALING' } }),
      prisma.apiToken.count({ where: { revokedAt: null } }),
      prisma.auditLog.count(),
    ]);

  const lines = [
    '# HELP kitora_users_total Total registered users.',
    '# TYPE kitora_users_total gauge',
    `kitora_users_total ${totalUsers}`,
    '# HELP kitora_users_new_7d Users registered in the last 7 days.',
    '# TYPE kitora_users_new_7d gauge',
    `kitora_users_new_7d ${newUsersLast7d}`,
    '# HELP kitora_subscriptions_active Active paid subscriptions.',
    '# TYPE kitora_subscriptions_active gauge',
    `kitora_subscriptions_active ${activeSubs}`,
    '# HELP kitora_subscriptions_trialing Subscriptions currently in trial.',
    '# TYPE kitora_subscriptions_trialing gauge',
    `kitora_subscriptions_trialing ${trialingSubs}`,
    '# HELP kitora_api_tokens_active Non-revoked personal API tokens.',
    '# TYPE kitora_api_tokens_active gauge',
    `kitora_api_tokens_active ${apiTokensActive}`,
    '# HELP kitora_audit_log_total Audit log entries (counter monotonically increases).',
    '# TYPE kitora_audit_log_total counter',
    `kitora_audit_log_total ${auditLogTotal}`,
    '',
  ];

  return new NextResponse(lines.join('\n'), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
