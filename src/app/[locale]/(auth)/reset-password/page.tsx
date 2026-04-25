import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ResetPasswordForm } from '@/components/auth/reset-password-form';
import { Link } from '@/i18n/routing';

export const metadata: Metadata = {
  title: 'Reset password',
};

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function ResetPasswordPage({ searchParams }: PageProps) {
  const { token } = await searchParams;
  const t = await getTranslations('auth.resetPassword');

  if (!token) {
    return (
      <div className="space-y-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('missing.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('missing.description')}</p>
        <Link
          href="/forgot-password"
          className="inline-block text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('missing.cta')}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <ResetPasswordForm token={token} />
    </div>
  );
}
