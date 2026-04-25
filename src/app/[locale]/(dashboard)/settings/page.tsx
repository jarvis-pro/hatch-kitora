import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { DangerZone } from '@/components/account/danger-zone';
import { PasswordForm } from '@/components/account/password-form';
import { ProfileForm } from '@/components/account/profile-form';
import { SessionsCard } from '@/components/account/sessions-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export const metadata: Metadata = {
  title: 'Settings',
};

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');

  const [t, user] = await Promise.all([
    getTranslations('account'),
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, name: true, email: true, passwordHash: true },
    }),
  ]);

  if (!user) redirect('/login');

  const hasPassword = Boolean(user.passwordHash);

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
