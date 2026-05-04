import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { WebhookEndpoints } from '@/components/account/webhook-endpoints';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireActiveOrg } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { can } from '@/services/orgs/permissions';

export const metadata: Metadata = { title: 'Webhooks' };
export const dynamic = 'force-dynamic';

/**
 * RFC 0003 PR-1 — `/settings/organization/webhooks`
 *
 * 仅限 OWNER/ADMIN。个人组织被拒绝（没有基础设施可集成）。
 * 详情页面位于 `/settings/organization/webhooks/[id]`
 * 并在同一 PR 中添加。
 */
export default async function WebhooksPage() {
  const me = await requireActiveOrg().catch(() => null);
  if (!me) redirect('/login');
  if (me.slug.startsWith('personal-')) redirect('/settings');
  if (!can(me.role, 'org.update')) redirect('/settings');

  const t = await getTranslations('orgs.webhooks');

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { orgId: me.orgId },
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <WebhookEndpoints orgSlug={me.slug} endpoints={endpoints} />
        </CardContent>
      </Card>
    </div>
  );
}
