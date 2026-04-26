import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { PasskeyList } from '@/components/account/passkey-list';
import { RegisterPasskeyButton } from '@/components/account/register-passkey-button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';

export const metadata: Metadata = {
  title: 'Passkeys',
};

export const dynamic = 'force-dynamic';

/**
 * RFC 0007 PR-2 — `/settings/security/passkeys`.
 *
 * Lists every WebAuthnCredential row for the current user and offers
 * register / rename / delete. Mirrors the RFC 0002 PR-1 Active Sessions
 * card layout for visual consistency.
 */
export default async function PasskeysSettingsPage() {
  const me = await requireUser().catch(() => null);
  if (!me) redirect('/login');

  const t = await getTranslations('account.passkeys');
  const credentials = await prisma.webAuthnCredential.findMany({
    where: { userId: me.id },
    select: {
      id: true,
      name: true,
      deviceType: true,
      backedUp: true,
      lastUsedAt: true,
      createdAt: true,
    },
    orderBy: [{ lastUsedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
  });

  return (
    <div className="container max-w-3xl py-10">
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <RegisterPasskeyButton />
          <PasskeyList credentials={credentials} />
        </CardContent>
      </Card>
    </div>
  );
}
