import type { Metadata } from 'next';
import { useTranslations } from 'next-intl';

import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import { Link } from '@/i18n/routing';

/**
 * 忘记密码页的元数据。
 */
export const metadata: Metadata = {
  title: 'Forgot password',
};

/**
 * 忘记密码页面。
 *
 * 允许未登录用户通过邮箱地址请求重置密码链接。
 * Client 端渲染，采用 i18n 国际化。
 *
 * @returns 忘记密码页面 JSX
 */
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
