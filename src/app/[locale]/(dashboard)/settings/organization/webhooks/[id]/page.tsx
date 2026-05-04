import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { WebhookDeliveries } from '@/components/account/webhook-deliveries';
import { WebhookDetail } from '@/components/account/webhook-detail';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireActiveOrg } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { can } from '@/services/orgs/permissions';

/**
 * Webhook 端点详情页的元数据。
 */
export const metadata: Metadata = { title: 'Webhook endpoint' };

// 禁用缓存，每次请求都重新获取最新数据
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Webhook 端点详情编辑页面。
 *
 * 允许组织所有者查看和编辑 Webhook 端点配置。
 * 显示最近 50 条发送记录。
 *
 * RFC 0003 PR-1 — 端点详情/编辑页。发送记录表格中的数据
 * 由定时任务填充，参见 PR-2。
 *
 * Server 端渲染，需要登录且拥有组织更新权限，采用 i18n 国际化。
 *
 * @param params 路由参数，包含 Webhook 端点 ID
 * @returns Webhook 端点详情页面 JSX
 */
export default async function WebhookDetailPage({ params }: PageProps) {
  // 验证用户登录且为活跃组织成员
  const me = await requireActiveOrg().catch(() => null);
  if (!me) redirect('/login');

  // 禁止个人组织访问（个人组织不支持 Webhook）
  if (me.slug.startsWith('personal-')) redirect('/settings');

  // 验证用户拥有组织更新权限
  if (!can(me.role, 'org.update')) redirect('/settings');

  const { id } = await params;
  // 并行查询 Webhook 端点配置和最近的发送记录
  const [endpoint, deliveries] = await Promise.all([
    prisma.webhookEndpoint.findFirst({
      where: { id, orgId: me.orgId },
      select: {
        id: true,
        url: true,
        description: true,
        enabledEvents: true,
        secretPrefix: true,
        disabledAt: true,
        consecutiveFailures: true,
        createdAt: true,
      },
    }),
    prisma.webhookDelivery.findMany({
      where: { endpointId: id, endpoint: { orgId: me.orgId } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        eventId: true,
        eventType: true,
        status: true,
        attempt: true,
        responseStatus: true,
        responseBody: true,
        errorMessage: true,
        payload: true,
        createdAt: true,
        completedAt: true,
      },
    }),
  ]);

  // 若端点不存在则返回 404
  if (!endpoint) notFound();

  const t = await getTranslations('orgs.webhooks');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('actions.edit')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            <code className="font-mono text-base">{endpoint.url}</code>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <WebhookDetail orgSlug={me.slug} endpoint={endpoint} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('deliveries.title')}</CardTitle>
          <CardDescription>{t('deliveries.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <WebhookDeliveries
            orgSlug={me.slug}
            endpointId={endpoint.id}
            deliveries={deliveries.map((d) => ({
              id: d.id,
              eventId: d.eventId,
              eventType: d.eventType,
              status: d.status,
              attempt: d.attempt,
              responseStatus: d.responseStatus,
              responseBody: d.responseBody,
              errorMessage: d.errorMessage,
              payload: d.payload,
              createdAt: d.createdAt,
              completedAt: d.completedAt,
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
