import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { WebhookEndpoints } from '@/components/account/webhook-endpoints';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireActiveOrg } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { can } from '@/lib/orgs/permissions';

export const metadata: Metadata = { title: 'Webhooks' };
export const dynamic = 'force-dynamic';

/**
 * RFC 0003 PR-1 — `/settings/organization/webhooks`
 *
 * OWNER / ADMIN only. Personal orgs are bounced (no infra to integrate with).
 * The detail page lives one level deeper at `/settings/organization/webhooks/[id]`
 * and is added in the same PR.
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
