'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';

import { Button } from '@/components/ui/button';

interface Props {
  /** Optional callback URL (typically `?callbackUrl=` from /login). */
  callbackUrl?: string;
}

/**
 * RFC 0007 PR-4 — "Sign in with a passkey" button on /login.
 *
 * Discoverable / usernameless flow:
 *   1. POST /api/auth/webauthn/authenticate/options (anonymous)
 *      — server stashes challenge in httpOnly cookie, returns options
 *        with `allowCredentials: []`.
 *   2. `navigator.credentials.get()` via SimpleWebAuthn — browser opens
 *      OS / password-manager picker.
 *   3. POST /api/auth/webauthn/authenticate/verify with the assertion —
 *      server reverse-looks-up the credential, mints session cookie,
 *      responds with `{ redirectTo }`.
 *   4. Browser navigates to `redirectTo` — middleware honours the fresh
 *      cookie immediately.
 *
 * The button is hidden when the browser doesn't support WebAuthn (RFC
 * 0007 §1 "降级先于扩展"). Soft-fails on user cancellation.
 */
export function SignInWithPasskeyButton({ callbackUrl }: Props) {
  const t = useTranslations('auth.login.passkey');
  const [supported, setSupported] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
  }, []);

  if (!supported) return null;

  function handleClick() {
    startTransition(async () => {
      try {
        const optionsRes = await fetch('/api/auth/webauthn/authenticate/options', {
          method: 'POST',
        });
        if (!optionsRes.ok) {
          toast.error(t('errors.optionsFailed'));
          return;
        }
        const options = await optionsRes.json();

        const assertion = await startAuthentication({ optionsJSON: options });

        const verifyRes = await fetch('/api/auth/webauthn/authenticate/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ response: assertion, callbackUrl }),
        });
        const result = (await verifyRes.json()) as {
          ok?: boolean;
          redirectTo?: string;
          error?: string;
        };
        if (!verifyRes.ok || !result.ok) {
          toast.error(t('errors.verifyFailed'));
          return;
        }

        // Hard navigate so middleware sees the freshly-set cookie on the
        // next request. router.replace would skip the cookie roundtrip.
        window.location.assign(result.redirectTo ?? '/dashboard');
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown';
        // User-aborted ceremonies throw NotAllowedError — soft-fail, the
        // user clearly chose not to authenticate.
        if (msg.includes('NotAllowedError') || msg.includes('cancelled')) return;
        toast.error(t('errors.generic'));
      }
    });
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      onClick={handleClick}
      disabled={pending}
    >
      {pending ? t('verifying') : t('cta')}
    </Button>
  );
}
