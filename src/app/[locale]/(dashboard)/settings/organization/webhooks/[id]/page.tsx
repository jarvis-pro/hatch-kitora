import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { WebhookDeliveries } from '@/components/account/webhook-deliveries';
import { WebhookDetail } from '@/components/account/webhook-detail';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireActiveOrg } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { can } from '@/lib/orgs/permissions';

export const metadata: Metadata = { title: 'Webhook endpoint' };
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * RFC 0003 PR-1 — endpoint detail / edit page. Deliveries table is
 * deliberately omitted here; PR-2 adds it once the cron exists to
 * populate rows.
 */
export default async function WebhookDetailPage({ params }: PageProps) {
  const me = await requireActiveOrg().catch(() => null);
  if (!me) redirect('/login');
  if (me.slug.startsWith('personal-')) redirect('/settings');
  if (!can(me.role, 'org.update')) redirect('/settings');

  const { id } = await params;
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
