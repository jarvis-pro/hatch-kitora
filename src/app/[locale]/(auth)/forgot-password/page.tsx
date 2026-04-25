import type { Metadata } from 'next';
import { useTranslations } from 'next-intl';

import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import { Link } from '@/i18n/routing';

export const metadata: Metadata = {
  title: 'Forgot password',
};

export default function ForgotPasswordPage() {
  const t = useTranslations('auth.forgotPassword');

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <ForgotPasswordForm />
      <p className="text-center text-sm text-muted-foreground">
        <Link
          href="/login"
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          {t('backToLogin')}
        </Link>
      </p>
    </div>
  );
}
