import { NextResponse } from 'next/server';

import { authenticateBearer } from '@/lib/api-auth';
import { getCurrentBilling } from '@/services/billing/current';
import { prisma } from '@/lib/db';
import { apiLimiter } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 公共 REST 端点 — `GET /api/v1/me`
 *
 * 演示端到端的个人 API 令牌流程：
 *   curl -H "Authorization: Bearer kitora_..." https://app.kitora.com/api/v1/me
 *
 * 返回已认证用户的个人资料 + 活跃组织的计划，以及用户所属的每个组织的列表
 * （包含他们在每个组织中的角色）。缺少/无效/撤销/过期令牌时返回 401；
 * 触发速率限制时返回 429。
 */
export async function GET(request: Request) {
  const principal = await authenticateBearer(request);
  if (!principal) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 每个令牌的限制器 — 对于服务器间调用者来说公平得多。
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

  const [user, billing, memberships] = await Promise.all([
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
    getCurrentBilling(principal.orgId),
    prisma.membership.findMany({
      where: { userId: principal.userId },
      orderBy: { joinedAt: 'asc' },
      select: {
        role: true,
        organization: { select: { slug: true, name: true, id: true } },
      },
    }),
  ]);

  if (!user) {
    // token 存活期超出了其所有者 —— 防御性返回 401 而非 500。
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const activeOrg = memberships.find((m) => m.organization.id === principal.orgId);

  return NextResponse.json(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role.toLowerCase(),
      emailVerified: !!user.emailVerified,
      createdAt: user.createdAt.toISOString(),
      activeOrg: activeOrg
        ? {
            slug: activeOrg.organization.slug,
            name: activeOrg.organization.name,
            role: activeOrg.role,
          }
        : null,
      organizations: memberships.map((m) => ({
        slug: m.organization.slug,
        name: m.organization.name,
        role: m.role,
      })),
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
