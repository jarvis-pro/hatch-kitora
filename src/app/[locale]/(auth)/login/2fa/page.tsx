import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { TwoFactorChallengeForm } from '@/components/auth/two-factor-challenge-form';
import { auth } from '@/lib/auth';

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
  return <TwoFactorChallengePanel callbackUrl={params.callbackUrl ?? '/dashboard'} />;
}

function TwoFactorChallengePanel({ callbackUrl }: { callbackUrl: string }) {
  const t = useTranslations('auth.twoFactorChallenge');
  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <TwoFactorChallengeForm callbackUrl={callbackUrl} />
    </div>
  );
}
