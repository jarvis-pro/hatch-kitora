import type { Metadata } from 'next';
import { useTranslations } from 'next-intl';

import { Link } from '@/i18n/routing';

import { SignupForm } from './_components/signup-form';

/**
 * 注册页的元数据。
 */
export const metadata: Metadata = {
  title: 'Create account',
};

/**
 * 用户注册页面。
 *
 * 允许新用户创建账户。若已登录会被重定向到仪表板。
 * Client 端渲染，采用 i18n 国际化。
 *
 * @returns 注册页面 JSX
 */
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
        <Link
          href="/login"
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          {t('loginLink')}
        </Link>
      </p>
    </div>
  );
}
