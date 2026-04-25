import type { Metadata } from 'next';
import { useTranslations } from 'next-intl';

import { SignupForm } from '@/components/auth/signup-form';
import { Link } from '@/i18n/routing';

export const metadata: Metadata = {
  title: 'Create account',
};

export default function SignupPage() {
  const t = useTranslations('auth.signup');

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <SignupForm />
      <p className="text-center text-sm text-muted-foreground">
        {t('haveAccount')}{' '}
        <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
          {t('loginLink')}
        </Link>
      </p>
    </div>
  );
}
