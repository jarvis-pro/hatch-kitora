'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { TwoFactorChallengeForm } from '@/components/auth/two-factor-challenge-form';
import { TwoFactorPasskeyForm } from '@/components/auth/two-factor-passkey-form';
import { cn } from '@/lib/utils';

interface Props {
  callbackUrl: string;
  hasTotp: boolean;
  hasPasskey: boolean;
}

type Tab = 'passkey' | 'totp';

/**
 * RFC 0007 PR-3 — wrapper that decides which 2FA factors to surface on
 * `/login/2fa` based on the user's enrolled methods.
 *
 *   Passkey only       → passkey form (no tabs)
 *   TOTP only          → existing TOTP form (no tabs)
 *   Both               → tabs, default to Passkey (better UX, fewer keystrokes)
 *   Neither            → impossible by route construction; middleware
 *                        wouldn't have routed here.
 */
export function TwoFactorChallengeTabs({ callbackUrl, hasTotp, hasPasskey }: Props) {
  const t = useTranslations('auth.twoFactorChallenge');
  // Default tab — Passkey wins when present; falls back to TOTP otherwise.
  const [active, setActive] = useState<Tab>(hasPasskey ? 'passkey' : 'totp');

  if (hasPasskey && !hasTotp) {
    return <TwoFactorPasskeyForm callbackUrl={callbackUrl} />;
  }
  if (hasTotp && !hasPasskey) {
    return <TwoFactorChallengeForm callbackUrl={callbackUrl} />;
  }

  // Both enrolled — render tabs.
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
