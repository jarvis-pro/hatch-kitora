import type { Metadata } from 'next';
import { useTranslations } from 'next-intl';

import { LoginForm } from '@/components/auth/login-form';
import { Link } from '@/i18n/routing';

export const metadata: Metadata = {
  title: 'Sign in',
};

export default function LoginPage() {
  const t = useTranslations('auth.login');

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <LoginForm />
      <div className="space-y-2 text-center text-sm text-muted-foreground">
        <p>
          <Link
            href="/forgot-password"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            {t('forgotPasswordLink')}
          </Link>
        </p>
        <p>
          {t('noAccount')}{' '}
          <Link
            href="/signup"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            {t('signupLink')}
          </Link>
        </p>
      </div>
    </div>
  );
}
