import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/routing';

import { ResetPasswordForm } from './_components/reset-password-form';

/**
 * 重置密码页的元数据。
 */
export const metadata: Metadata = {
  title: 'Reset password',
};

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

/**
 * 重置密码页面。
 *
 * 接受邮件中的令牌，允许用户设置新密码。若缺少令牌则显示错误信息。
 * Server 端渲染，采用 i18n 国际化。
 *
 * @param searchParams 查询参数，包含重置密码令牌 token
 * @returns 重置密码页面 JSX
 */
export default async function ResetPasswordPage({ searchParams }: PageProps) {
  const { token } = await searchParams;
  const t = await getTranslations('auth.resetPassword');

  // 验证令牌是否存在，若缺失显示错误提示
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
