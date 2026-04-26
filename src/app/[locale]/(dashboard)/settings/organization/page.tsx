import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { OrgDangerZone } from '@/components/account/org-danger-zone';
import { OrgDataExportCard } from '@/components/account/org-data-export-card';
import { OrgSettingsForm } from '@/components/account/org-settings-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { OrgRole } from '@prisma/client';
import { requireActiveOrg } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { can } from '@/lib/orgs/permissions';

export const metadata: Metadata = { title: 'Organization' };
export const dynamic = 'force-dynamic';

export default async function OrganizationSettingsPage() {
  const me = await requireActiveOrg().catch(() => null);
  if (!me) redirect('/login');

  // Personal orgs are bound to the user account — no rename / delete UI here.
  if (me.slug.startsWith('personal-')) redirect('/settings');

  if (!can(me.role, 'org.update')) redirect('/settings');

  const t = await getTranslations('orgs.settings');

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: me.orgId },
    select: { name: true, slug: true },
  });

  const canDelete = can(me.role, 'org.delete');
  // RFC 0002 PR-3 — OWNER-only org data export.
  const isOwner = me.role === OrgRole.OWNER;
  const orgExports = isOwner
    ? await prisma.dataExportJob.findMany({
        where: { orgId: me.orgId, scope: 'ORG' },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          status: true,
          sizeBytes: true,
          expiresAt: true,
          createdAt: true,
        },
      })
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('basics.title')}</CardTitle>
          <CardDescription>{t('basics.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <OrgSettingsForm defaultName={org.name} defaultSlug={org.slug} />
        </CardContent>
      </Card>

      {isOwner ? (
        <Card>
          <CardHeader>
            <CardTitle>Export organization data</CardTitle>
            <CardDescription>
              Download a zip with the organization's members, invitations, audit, tokens and
              subscriptions. The link is auth-gated and expires after 7 days.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OrgDataExportCard orgSlug={org.slug} jobs={orgExports} />
          </CardContent>
        </Card>
      ) : null}

      {canDelete ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">{t('danger.title')}</CardTitle>
            <CardDescription>{t('danger.subtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            <OrgDangerZone orgSlug={org.slug} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
