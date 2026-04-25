import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ResendVerificationForm } from '@/components/auth/resend-verification-form';
import { Link } from '@/i18n/routing';
import { verifyEmailAction } from '@/lib/auth/actions';

export const metadata: Metadata = {
  title: 'Verify email',
};

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function VerifyEmailPage({ searchParams }: PageProps) {
  const { token } = await searchParams;
  const t = await getTranslations('auth.verifyEmail');

  // Token present → consume server-side and render result.
  if (token) {
    const result = await verifyEmailAction({ token });

    if (result.ok) {
      return (
        <div className="space-y-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{t('success.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('success.description')}</p>
          <Link
            href="/login"
            className="inline-block text-sm font-medium underline-offset-4 hover:underline"
          >
            {t('success.cta')}
          </Link>
        </div>
      );
    }

    const heading = result.error === 'expired' ? t('expired.title') : t('invalid.title');
    const description =
      result.error === 'expired' ? t('expired.description') : t('invalid.description');

    return (
      <div className="space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <ResendVerificationForm />
      </div>
    );
  }

  // No token → resend flow (e.g. user lost the email).
  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('resend.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('resend.subtitle')}</p>
      </div>
      <ResendVerificationForm />
    </div>
  );
}
