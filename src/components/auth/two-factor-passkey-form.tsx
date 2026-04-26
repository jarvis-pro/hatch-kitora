'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { startAuthentication } from '@simplewebauthn/browser';

import {
  getPasskeyChallengeAction,
  verifyPasskeyForCurrentSessionAction,
} from '@/lib/account/passkeys';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/routing';

interface Props {
  callbackUrl: string;
}

/**
 * RFC 0007 PR-3 — Passkey-based 2FA challenge form.
 *
 * Single button: click → server action mints challenge → browser
 * `startAuthentication()` → server action verifies + flips
 * tfa_pending. Symmetric with the TOTP form's submit path; the only
 * difference is no manual code entry.
 */
export function TwoFactorPasskeyForm({ callbackUrl }: Props) {
  const t = useTranslations('auth.twoFactorChallenge.passkey');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      try {
        const challengeResult = await getPasskeyChallengeAction();
        if (!challengeResult.ok) {
          toast.error(t('errors.optionsFailed'));
          return;
        }

        const assertion = await startAuthentication({ optionsJSON: challengeResult.options });

        const verifyResult = await verifyPasskeyForCurrentSessionAction({ response: assertion });
        if (!verifyResult.ok) {
          toast.error(
            verifyResult.error === 'verification-failed' ||
              verifyResult.error === 'unknown-credential'
              ? t('errors.verifyFailed')
              : t('errors.generic'),
          );
          return;
        }

        router.replace(callbackUrl as '/dashboard');
        router.refresh();
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown';
        // User-aborted ceremony → soft fail.
        if (msg.includes('NotAllowedError') || msg.includes('cancelled')) return;
        toast.error(t('errors.generic'));
      }
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <Button type="button" className="w-full" onClick={handleClick} disabled={pending}>
        {pending ? t('verifying') : t('cta')}
      </Button>
    </div>
  );
}
