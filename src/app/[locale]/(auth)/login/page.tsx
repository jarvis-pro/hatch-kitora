import type { Metadata } from 'next';
import { useTranslations } from 'next-intl';

import { LoginForm } from '@/components/auth/login-form';
import { SignInWithPasskeyButton } from '@/components/auth/sign-in-with-passkey-button';
import { Link } from '@/i18n/routing';

export const metadata: Metadata = {
  title: 'Sign in',
};

interface PageProps {
  searchParams: Promise<{ callbackUrl?: string }>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const callbackUrl = typeof params.callbackUrl === 'string' ? params.callbackUrl : undefined;

  return <LoginPageContent callbackUrl={callbackUrl} />;
}

function LoginPageContent({ callbackUrl }: { callbackUrl?: string }) {
  const t = useTranslations('auth.login');

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <LoginForm />
      {/* RFC 0007 PR-4 — 无密码入口。仅当浏览器支持 WebAuthn
          时呈现（组件自己把关）。视觉分隔符被刻意柔和，
          以便密码表单对尚未注册密钥的用户保持主要 CTA。*/}
      <div className="relative">
        <div aria-hidden className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">{t('passkey.divider')}</span>
        </div>
      </div>
      <SignInWithPasskeyButton callbackUrl={callbackUrl} />
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
