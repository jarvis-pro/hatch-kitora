import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { TwoFactorChallengeTabs } from '@/components/auth/two-factor-challenge-tabs';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export const metadata: Metadata = {
  title: 'Two-factor authentication',
};

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ callbackUrl?: string }>;
}

/**
 * RFC 0002 PR-2 — interstitial that runs after sign-in for any user with
 * 2FA enabled. The middleware (`authConfig.callbacks.authorized`) is what
 * funnels users here; this page just protects against direct visits when
 * the user is either not logged in (-> /login) or already verified
 * (-> dashboard or callback).
 *
 * RFC 0007 PR-3 — extended to surface a Passkey tab alongside TOTP when
 * the user has any registered WebAuthn credential. The wrapper component
 * picks the right UI shape based on which factors the user owns.
 */
export default async function TwoFactorChallengePage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/login');
  }
  if (!session.tfaPending) {
    const params = await searchParams;
    redirect(params.callbackUrl || '/dashboard');
  }
  const params = await searchParams;

  // Decide which tabs to surface. `User.twoFactorEnabled` is the boolean
  // gate; the row-level lookups distinguish "TOTP active" vs "Passkey
  // present" so the UI can pick an appropriate prompt.
  const [totpRow, passkeyCount] = await Promise.all([
    prisma.twoFactorSecret.findUnique({
      where: { userId: session.user.id },
      select: { enabledAt: true },
    }),
    prisma.webAuthnCredential.count({ where: { userId: session.user.id } }),
  ]);
  const hasTotp = totpRow?.enabledAt != null;
  const hasPasskey = passkeyCount > 0;

  return (
    <TwoFactorChallengePanel
      callbackUrl={params.callbackUrl ?? '/dashboard'}
      hasTotp={hasTotp}
      hasPasskey={hasPasskey}
    />
  );
}

function TwoFactorChallengePanel({
  callbackUrl,
  hasTotp,
  hasPasskey,
}: {
  callbackUrl: string;
  hasTotp: boolean;
  hasPasskey: boolean;
}) {
  const t = useTranslations('auth.twoFactorChallenge');
  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <TwoFactorChallengeTabs callbackUrl={callbackUrl} hasTotp={hasTotp} hasPasskey={hasPasskey} />
    </div>
  );
}
