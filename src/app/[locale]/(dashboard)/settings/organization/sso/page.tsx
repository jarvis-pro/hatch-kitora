import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { SsoProviders } from '@/components/account/sso-providers';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireActiveOrg } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { can } from '@/lib/orgs/permissions';

export const metadata: Metadata = { title: 'SSO' };
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-1 — `/settings/organization/sso`
 *
 * OWNER / ADMIN only. Personal orgs are bounced (no IdP to integrate with).
 * Detail / edit interactions live in the same page via inline forms — there
 * are at most 2 IdP rows per org so a separate detail route isn't worth the
 * round-trip.
 */
export default async function SsoPage() {
  const me = await requireActiveOrg().catch(() => null);
  if (!me) redirect('/login');
  if (me.slug.startsWith('personal-')) redirect('/settings');
  if (!can(me.role, 'org.update')) redirect('/settings');

  const t = await getTranslations('orgs.sso');

  const providers = await prisma.identityProvider.findMany({
    where: { orgId: me.orgId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      protocol: true,
      emailDomains: true,
      defaultRole: true,
      enforceForLogin: true,
      enabledAt: true,
      scimEnabled: true,
      scimTokenPrefix: true,
      oidcIssuer: true,
      oidcClientId: true,
      // We deliberately do not select samlMetadata here — it's huge and the
      // list view doesn't need it. Edit form re-fetches when opened.
      createdAt: true,
      updatedAt: true,
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
          <CardTitle>{t('providers.title')}</CardTitle>
          <CardDescription>{t('providers.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <SsoProviders
            orgSlug={me.slug}
            isOwner={me.role === 'OWNER'}
            providers={providers.map((p) => ({
              id: p.id,
              name: p.name,
              protocol: p.protocol,
              emailDomains: p.emailDomains,
              defaultRole: p.defaultRole,
              enforceForLogin: p.enforceForLogin,
              enabledAt: p.enabledAt?.toISOString() ?? null,
              scimEnabled: p.scimEnabled,
              scimTokenPrefix: p.scimTokenPrefix,
              oidcIssuer: p.oidcIssuer,
              oidcClientId: p.oidcClientId,
              createdAt: p.createdAt.toISOString(),
              updatedAt: p.updatedAt.toISOString(),
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
