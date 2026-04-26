import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { ApiTokens } from '@/components/account/api-tokens';
import { ConnectedAccounts } from '@/components/account/connected-accounts';
import { DangerZone } from '@/components/account/danger-zone';
import { PasswordForm } from '@/components/account/password-form';
import { ProfileForm } from '@/components/account/profile-form';
import { SessionsCard } from '@/components/account/sessions-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { env } from '@/env';
import { requireActiveOrg } from '@/lib/auth/session';
import { prisma } from '@/lib/db';

export const metadata: Metadata = {
  title: 'Settings',
};

export const dynamic = 'force-dynamic';

/** Providers configured at deploy time — only show those with credentials set. */
function availableOAuthProviders(): readonly { id: string; label: string }[] {
  const list: { id: string; label: string }[] = [];
  if (env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET) list.push({ id: 'github', label: 'GitHub' });
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) list.push({ id: 'google', label: 'Google' });
  return list;
}

export default async function SettingsPage() {
  const me = await requireActiveOrg().catch(() => null);
  if (!me) redirect('/login');

  // tokens 按 orgId 查（PR-2：active org 范围）。user 仍按 userId 查（profile / accounts 是 user-scoped）。
  const [t, user, tokens] = await Promise.all([
    getTranslations('account'),
    prisma.user.findUnique({
      where: { id: me.userId },
      select: {
        id: true,
        name: true,
        email: true,
        passwordHash: true,
        accounts: { select: { provider: true } },
      },
    }),
    prisma.apiToken.findMany({
      where: { orgId: me.orgId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        prefix: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
      },
    }),
  ]);

  if (!user) redirect('/login');

  const hasPassword = Boolean(user.passwordHash);
  const oauthProviders = availableOAuthProviders();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('profile.title')}</CardTitle>
          <CardDescription>{t('profile.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileForm defaultName={user.name ?? ''} email={user.email} />
        </CardContent>
      </Card>

      {hasPassword ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('security.title')}</CardTitle>
            <CardDescription>{t('security.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <PasswordForm />
          </CardContent>
        </Card>
      ) : null}

      {oauthProviders.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('connected.title')}</CardTitle>
            <CardDescription>{t('connected.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ConnectedAccounts
              available={oauthProviders}
              linked={user.accounts.map((a) => ({ provider: a.provider }))}
              hasPassword={hasPassword}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('apiTokens.title')}</CardTitle>
          <CardDescription>{t('apiTokens.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ApiTokens tokens={tokens} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('sessions.title')}</CardTitle>
          <CardDescription>{t('sessions.descriptionShort')}</CardDescription>
        </CardHeader>
        <CardContent>
          <SessionsCard />
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">{t('danger.title')}</CardTitle>
          <CardDescription>{t('danger.descriptionShort')}</CardDescription>
        </CardHeader>
        <CardContent>
          <DangerZone email={user.email} />
        </CardContent>
      </Card>
    </div>
  );
}
