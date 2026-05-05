import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';

import { TwoFactorChallengeTabs } from './_components/two-factor-challenge-tabs';

export const metadata: Metadata = {
  title: 'Two-factor authentication',
};

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ callbackUrl?: string }>;
}

/**
 * RFC 0002 PR-2 — 在任何启用 2FA 的用户登录后运行的幕间。
 * 中间件（`authConfig.callbacks.authorized`）是将用户漏斗到这里的东西；
 * 此页面只是防止在用户未登录（-> /login）或已验证
 * （-> 仪表板或回调）时的直接访问。
 *
 * RFC 0007 PR-3 — 扩展为在用户拥有任何已注册的 WebAuthn 凭据时
 * 在 TOTP 旁显示密钥标签。包装器组件根据用户拥有的因素
 * 选择正确的 UI 形状。
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

  // 决定要显示哪些标签。`User.twoFactorEnabled` 是布尔值
  // 门；行级查找区分"TOTP 活跃"与"密钥
  // 存在"，以便 UI 可以选择适当的提示。
  const [totpRow, passkeyCount] = await Promise.all([
    prisma.twoFactorSecret.findUnique({
      where: { userId: session.user.id },
      select: { enabledAt: true },
    }),
    prisma.webAuthnCredential.count({ where: { userId: session.user.id } }),
  ]);
  const hasTotp = totpRow?.enabledAt != null;
  const hasPasskey = passkeyCount > 0;

  return (
    <TwoFactorChallengePanel
      callbackUrl={params.callbackUrl ?? '/dashboard'}
      hasTotp={hasTotp}
      hasPasskey={hasPasskey}
    />
  );
}

function TwoFactorChallengePanel({
  callbackUrl,
  hasTotp,
  hasPasskey,
}: {
  callbackUrl: string;
  hasTotp: boolean;
  hasPasskey: boolean;
}) {
  const t = useTranslations('auth.twoFactorChallenge');
  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <TwoFactorChallengeTabs callbackUrl={callbackUrl} hasTotp={hasTotp} hasPasskey={hasPasskey} />
    </div>
  );
}
