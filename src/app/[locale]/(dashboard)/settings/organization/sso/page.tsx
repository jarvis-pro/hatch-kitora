import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { SsoProviders } from '@/components/account/sso-providers';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireActiveOrg } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { can } from '@/services/orgs/permissions';

export const metadata: Metadata = { title: 'SSO' };
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-1 — `/settings/organization/sso`
 *
 * 仅限 OWNER/ADMIN。个人组织被拒绝（没有 IdP 可集成）。
 * 详情/编辑交互通过内联表单存在于同一页面 —
 * 每个组织最多有 2 个 IdP 行，因此单独的详情路由不值得
 * 往返。
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
      // 我们故意不在此处选择 samlMetadata — 它很大，
      // 列表视图不需要它。编辑表单打开时重新获取。
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
