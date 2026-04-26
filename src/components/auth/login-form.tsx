'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { loginAction } from '@/lib/auth/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

type Values = z.infer<typeof schema>;

/**
 * RFC 0004 PR-2 — login form with three modes:
 *
 *   - `password`  (default) — email + password fields.
 *   - `sso-only`  — only the email field; submitting POSTs to
 *                    `/api/auth/sso/start`. Triggered when the user's email
 *                    domain matches an org with `enforceForLogin = true`,
 *                    or when they explicitly clicked "Continue with SSO".
 *   - `sso-suggested` — same shape as `sso-only` but with a back-arrow that
 *                       restores the password fields. Triggered manually.
 *
 * The `sso_error` query param (set by /api/auth/sso/start + /callback) is
 * surfaced as an inline alert. Codes are mapped to friendly strings via the
 * `auth.login.sso.errors.*` i18n table.
 */
export function LoginForm() {
  const t = useTranslations('auth.login');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [mode, setMode] = useState<'password' | 'sso-suggested' | 'sso-only'>('password');
  const [ssoEmail, setSsoEmail] = useState('');
  const [ssoErrorBanner, setSsoErrorBanner] = useState<string | null>(null);

  // Pick up `?sso_error=...` from /start or /callback. URLSearchParams is
  // safe in `'use client'`; we don't depend on it during SSR.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('sso_error');
    if (code) setSsoErrorBanner(code);
  }, []);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = (values: Values) => {
    startTransition(async () => {
      const result = await loginAction(values);
      if (result.ok) {
        router.replace('/dashboard');
        router.refresh();
        return;
      }
      // RFC 0004 PR-2 — the user's org has flipped on `enforceForLogin`.
      // Switch the form to SSO-only with the email pre-filled instead of
      // showing the generic "invalid credentials" toast.
      if (result.error === 'sso-required') {
        setSsoEmail(result.email ?? values.email);
        setMode('sso-only');
        return;
      }
      toast.error(t('errors.invalid'));
    });
  };

  const ssoErrorText = ssoErrorBanner ? mapSsoError(t, ssoErrorBanner) : null;

  return (
    <div className="space-y-4">
      {ssoErrorText ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {ssoErrorText}
        </div>
      ) : null}

      {mode === 'password' ? (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{t('fields.email')}</Label>
            <Input id="email" type="email" autoComplete="email" {...register('email')} />
            {errors.email ? (
              <p className="text-xs text-destructive">{errors.email.message}</p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t('fields.password')}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              {...register('password')}
            />
            {errors.password ? (
              <p className="text-xs text-destructive">{errors.password.message}</p>
            ) : null}
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? t('submitting') : t('submit')}
          </Button>

          <div className="relative my-2">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">{t('sso.divider')}</span>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={pending}
            onClick={() => setMode('sso-suggested')}
          >
            {t('sso.continueButton')}
          </Button>
        </form>
      ) : (
        <SsoEmailRail
          email={ssoEmail}
          locked={mode === 'sso-only'}
          onBack={mode === 'sso-suggested' ? () => setMode('password') : null}
          lockedNotice={mode === 'sso-only' ? t('sso.lockedNotice') : null}
        />
      )}
    </div>
  );
}

/**
 * The SSO-only rail. Submits a native form POST to `/api/auth/sso/start`
 * (rather than fetch) so the cookie set on the response actually lands —
 * the redirect chain ending at the IdP needs the cookie attached to the
 * pre-redirect navigation.
 */
function SsoEmailRail({
  email,
  locked,
  onBack,
  lockedNotice,
}: {
  email: string;
  /** True when the form is showing because the org enforces SSO. Disables the email field. */
  locked: boolean;
  /** Provided when the user can switch back to password mode. */
  onBack: (() => void) | null;
  lockedNotice: string | null;
}) {
  const t = useTranslations('auth.login');
  return (
    <form
      method="POST"
      action="/api/auth/sso/start"
      className="space-y-4"
      // Surface the email value as default — readonly when locked.
      key={email /* re-render the input on locked-flip */}
    >
      {lockedNotice ? (
        <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-sm text-blue-700 dark:text-blue-400">
          {lockedNotice}
        </div>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="sso-email">{t('fields.email')}</Label>
        <Input
          id="sso-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          defaultValue={email}
          readOnly={locked}
        />
      </div>
      <Button type="submit" className="w-full">
        {t('sso.continueButton')}
      </Button>
      {onBack ? (
        <Button type="button" variant="ghost" className="w-full" onClick={onBack}>
          {t('sso.back')}
        </Button>
      ) : null}
    </form>
  );
}

function mapSsoError(t: ReturnType<typeof useTranslations>, code: string): string {
  // Normalize `invalid-domain:reason` into the generic invalid-domain bucket
  // — the user doesn't need to see the validator's internal reason here.
  const head = code.split(':')[0] ?? code;
  const knownKeys = new Set([
    'email-required',
    'bad-email',
    'no-idp',
    'authorize-failed',
    'invalid-input',
    'state-mismatch',
    'missing-code',
    'idp-rejected',
    'token-exchange-failed',
    'token-missing',
    'userinfo-failed',
    'userinfo-incomplete',
    'idp-not-found',
    'jit-failed',
    'user-gone',
    'acs-bad-form',
    'acs-no-response',
    'acs-validation-failed',
    'acs-no-redirect',
    'invalid-domain',
  ]);
  const key = knownKeys.has(head) ? head : 'generic';
  return t(`sso.errors.${key.replace(/-/g, '_')}`);
}
