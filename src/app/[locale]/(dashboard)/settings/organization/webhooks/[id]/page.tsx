import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { WebhookDetail } from '@/components/account/webhook-detail';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  const endpoint = await prisma.webhookEndpoint.findFirst({
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
  });
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
    </div>
  );
}
