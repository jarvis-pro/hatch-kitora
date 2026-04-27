import { NextResponse } from 'next/server';

import { authenticateBearer } from '@/lib/api-auth';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Prometheus 格式的指标端点。
 *
 * 鉴权：需要所有者具有 ADMIN 角色的 Bearer ApiToken。我们不使用会话 Cookie，
 * 因此 Prometheus scraper / 外部监视器可以在不存储 Cookie 的情况下轮询它。
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

  const [
    totalUsers,
    newUsersLast7d,
    activeSubs,
    trialingSubs,
    apiTokensActive,
    auditLogTotal,
    webhookEndpointsByDisabled,
    webhookDeliveriesByStatus,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.subscription.count({ where: { status: 'ACTIVE' } }),
    prisma.subscription.count({ where: { status: 'TRIALING' } }),
    prisma.apiToken.count({ where: { revokedAt: null } }),
    prisma.auditLog.count(),
    // RFC 0003 PR-4 — Webhook 可观测性。groupBy 使 Prometheus scrape
    // 保持在恒定的 ~10 个语句，无论我们稍后添加多少个交付状态。
    prisma.webhookEndpoint.groupBy({
      by: ['disabledAt'],
      _count: { _all: true },
    }),
    prisma.webhookDelivery.groupBy({
      by: ['status'],
      _count: { _all: true },
    }),
  ]);

  // 将端点 groupBy 滚动到 {disabled: count} 对。我们仅公开
  // 实时/禁用的拆分，从不公开原始时间戳。
  let endpointsLive = 0;
  let endpointsDisabled = 0;
  for (const row of webhookEndpointsByDisabled) {
    if (row.disabledAt === null) endpointsLive += row._count._all;
    else endpointsDisabled += row._count._all;
  }

  const STATUSES = ['PENDING', 'RETRYING', 'DELIVERED', 'DEAD_LETTER', 'CANCELED'] as const;
  const deliveriesByStatus: Record<string, number> = Object.fromEntries(
    STATUSES.map((s) => [s, 0]),
  );
  for (const row of webhookDeliveriesByStatus) {
    deliveriesByStatus[row.status] = row._count._all;
  }

  const lines = [
    '# HELP kitora_users_total 注册用户总数。',
    '# TYPE kitora_users_total gauge',
    `kitora_users_total ${totalUsers}`,
    '# HELP kitora_users_new_7d 过去 7 天注册的用户。',
    '# TYPE kitora_users_new_7d gauge',
    `kitora_users_new_7d ${newUsersLast7d}`,
    '# HELP kitora_subscriptions_active 活跃的付费订阅。',
    '# TYPE kitora_subscriptions_active gauge',
    `kitora_subscriptions_active ${activeSubs}`,
    '# HELP kitora_subscriptions_trialing 当前处于试用的订阅。',
    '# TYPE kitora_subscriptions_trialing gauge',
    `kitora_subscriptions_trialing ${trialingSubs}`,
    '# HELP kitora_api_tokens_active 未撤销的个人 API 令牌。',
    '# TYPE kitora_api_tokens_active gauge',
    `kitora_api_tokens_active ${apiTokensActive}`,
    '# HELP kitora_audit_log_total 审计日志条目（计数器单调递增）。',
    '# TYPE kitora_audit_log_total counter',
    `kitora_audit_log_total ${auditLogTotal}`,
    // RFC 0003 PR-4 — Webhook 可观测性
    '# HELP kitora_webhook_endpoints_total 按禁用状态分组的 Webhook 端点。',
    '# TYPE kitora_webhook_endpoints_total gauge',
    `kitora_webhook_endpoints_total{disabled="false"} ${endpointsLive}`,
    `kitora_webhook_endpoints_total{disabled="true"} ${endpointsDisabled}`,
    '# HELP kitora_webhook_deliveries_total Webhook 交付行按状态分组。行在状态机中原位改变；下面的 kitora_webhook_dead_letter_total 视图是实际的警报基准。',
    '# TYPE kitora_webhook_deliveries_total gauge',
    ...STATUSES.map(
      (s) => `kitora_webhook_deliveries_total{status="${s}"} ${deliveriesByStatus[s]}`,
    ),
    '# HELP kitora_webhook_dead_letter_total 当前处于 DEAD_LETTER 的 Webhook 交付。监视非零变化率。',
    '# TYPE kitora_webhook_dead_letter_total gauge',
    `kitora_webhook_dead_letter_total ${deliveriesByStatus.DEAD_LETTER}`,
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
