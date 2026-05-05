'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { cn } from '@/lib/utils';

import { TwoFactorChallengeForm } from './two-factor-challenge-form';
import { TwoFactorPasskeyForm } from './two-factor-passkey-form';

interface Props {
  callbackUrl: string;
  hasTotp: boolean;
  hasPasskey: boolean;
}

type Tab = 'passkey' | 'totp';

/**
 * RFC 0007 PR-3 — 包装器，根据用户注册的方法
 * 决定在 `/login/2fa` 上显示哪些 2FA 因素。
 *
 *   仅通行密钥       → 通行密钥表单（无选项卡）
 *   仅 TOTP          → 现有 TOTP 表单（无选项卡）
 *   两者               → 选项卡，默认为通行密钥（更好的 UX，更少的击键）
 *   两者都不          → 通过路由构造不可能；中间件
 *                        不会在这里路由。
 */
export function TwoFactorChallengeTabs({ callbackUrl, hasTotp, hasPasskey }: Props) {
  const t = useTranslations('auth.twoFactorChallenge');
  // 默认选项卡 — 通行密钥当存在时获胜；否则回退到 TOTP。
  const [active, setActive] = useState<Tab>(hasPasskey ? 'passkey' : 'totp');

  if (hasPasskey && !hasTotp) {
    return <TwoFactorPasskeyForm callbackUrl={callbackUrl} />;
  }
  if (hasTotp && !hasPasskey) {
    return <TwoFactorChallengeForm callbackUrl={callbackUrl} />;
  }

  // 两者都注册 — 呈现选项卡。
  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-md bg-muted p-1">
        <TabButton
          active={active === 'passkey'}
          onClick={() => setActive('passkey')}
          label={t('tabs.passkey')}
        />
        <TabButton
          active={active === 'totp'}
          onClick={() => setActive('totp')}
          label={t('tabs.totp')}
        />
      </div>
      {active === 'passkey' ? (
        <TwoFactorPasskeyForm callbackUrl={callbackUrl} />
      ) : (
        <TwoFactorChallengeForm callbackUrl={callbackUrl} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}
