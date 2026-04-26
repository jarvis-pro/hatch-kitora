'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  disableAction,
  enrollConfirmAction,
  enrollStartAction,
  regenerateBackupCodesAction,
} from '@/lib/account/two-factor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';

interface Props {
  /** Whether 2FA is currently active on the account (User.twoFactorEnabled). */
  enabled: boolean;
}

interface PendingEnrollment {
  secret: string;
  otpauthUri: string;
  backupCodes: string[];
  acknowledgedBackup: boolean;
}

/**
 * RFC 0002 PR-2 — three-state UI for /settings:
 *
 *   disabled                     → "Enable 2FA" CTA
 *   enrolling (pending state)    → secret + backup codes + 6-digit confirm
 *   enabled                      → Disable 2FA · Regenerate backup codes
 *
 * QR rendering is deliberately out of scope for v1 — adding `qrcode` as a
 * dep is on the PR-2.x polish list. Authenticator apps all support pasting
 * the otpauth URI or entering the base32 secret manually, so this is no
 * blocker for going live.
 */
export function TwoFactorCard({ enabled }: Props) {
  const t = useTranslations('account.twoFactor');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [enrollment, setEnrollment] = useState<PendingEnrollment | null>(null);
  const [confirmCode, setConfirmCode] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [freshBackupCodes, setFreshBackupCodes] = useState<string[] | null>(null);

  const onEnableClick = () => {
    startTransition(async () => {
      const result = await enrollStartAction();
      if (!result.ok) {
        toast.error(
          result.error === 'already-enabled'
            ? t('errors.alreadyEnabled')
            : result.error === 'no-email'
              ? t('errors.noEmail')
              : t('errors.generic'),
        );
        return;
      }
      setEnrollment({
        secret: result.secret,
        otpauthUri: result.otpauthUri,
        backupCodes: result.backupCodes,
        acknowledgedBackup: false,
      });
    });
  };

  const onConfirmEnroll = () => {
    startTransition(async () => {
      const result = await enrollConfirmAction({ code: confirmCode });
      if (!result.ok) {
        toast.error(
          result.error === 'wrong-code'
            ? t('errors.wrongCode')
            : result.error === 'not-enrolled'
              ? t('errors.notEnabled')
              : t('errors.generic'),
        );
        return;
      }
      toast.success(t('enabled'));
      setEnrollment(null);
      setConfirmCode('');
      router.refresh();
    });
  };

  const onDisable = () => {
    startTransition(async () => {
      const result = await disableAction({ code: disableCode });
      if (!result.ok) {
        toast.error(
          result.error === 'wrong-code'
            ? t('errors.wrongCode')
            : result.error === 'not-enabled'
              ? t('errors.notEnabled')
              : t('errors.generic'),
        );
        return;
      }
      setDisableCode('');
      router.refresh();
    });
  };

  const onRegenerate = () => {
    startTransition(async () => {
      const result = await regenerateBackupCodesAction();
      if (!result.ok) {
        toast.error(t('errors.generic'));
        return;
      }
      setFreshBackupCodes(result.backupCodes);
      toast.success(t('regenerated'));
    });
  };

  const onCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('copied'));
    } catch {
      // Clipboard can fail on http or Safari without focus — non-fatal.
    }
  };

  // ── State 1: not enrolled ─────────────────────────────────────────────
  if (!enabled && !enrollment) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('descriptionDisabled')}</p>
        <Button onClick={onEnableClick} disabled={pending}>
          {pending ? t('confirming') : t('enable')}
        </Button>
      </div>
    );
  }

  // ── State 2: enrolling ────────────────────────────────────────────────
  if (enrollment) {
    return (
      <div className="space-y-5">
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{t('enrollIntro')}</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="setup-key">{t('secretLabel')}</Label>
          <div className="flex gap-2">
            <Input id="setup-key" readOnly value={enrollment.secret} className="font-mono" />
            <Button variant="outline" type="button" onClick={() => onCopy(enrollment.secret)}>
              {t('copy')}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="otpauth">{t('otpauthLabel')}</Label>
          <div className="flex gap-2">
            <Input id="otpauth" readOnly value={enrollment.otpauthUri} className="font-mono" />
            <Button variant="outline" type="button" onClick={() => onCopy(enrollment.otpauthUri)}>
              {t('copy')}
            </Button>
          </div>
        </div>

        <div className="space-y-2 rounded-md border bg-muted/30 p-4">
          <h4 className="text-sm font-semibold">{t('backupTitle')}</h4>
          <p className="text-xs text-muted-foreground">{t('backupIntro')}</p>
          <ul className="mt-2 grid grid-cols-2 gap-2 font-mono text-sm">
            {enrollment.backupCodes.map((code) => (
              <li key={code} className="rounded bg-background px-2 py-1">
                {code}
              </li>
            ))}
          </ul>
          <label className="mt-2 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={enrollment.acknowledgedBackup}
              onChange={(e) =>
                setEnrollment((prev) =>
                  prev ? { ...prev, acknowledgedBackup: e.target.checked } : prev,
                )
              }
            />
            {t('backupAcknowledge')}
          </label>
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm-code">{t('codeLabel')}</Label>
          <Input
            id="confirm-code"
            inputMode="numeric"
            placeholder={t('codePlaceholder')}
            value={confirmCode}
            onChange={(e) => setConfirmCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="font-mono"
          />
          <Button
            onClick={onConfirmEnroll}
            disabled={pending || !enrollment.acknowledgedBackup || confirmCode.length !== 6}
          >
            {pending ? t('confirming') : t('confirm')}
          </Button>
        </div>
      </div>
    );
  }

  // ── State 3: enabled ──────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">{t('descriptionEnabled')}</p>

      <div className="space-y-2 rounded-md border p-4">
        <h4 className="text-sm font-semibold">{t('backupTitle')}</h4>
        <p className="text-xs text-muted-foreground">{t('backupIntro')}</p>
        {freshBackupCodes ? (
          <ul className="mt-2 grid grid-cols-2 gap-2 font-mono text-sm">
            {freshBackupCodes.map((code) => (
              <li key={code} className="rounded bg-background px-2 py-1">
                {code}
              </li>
            ))}
          </ul>
        ) : null}
        <Button variant="outline" onClick={onRegenerate} disabled={pending} className="mt-2">
          {pending ? t('regenerating') : t('regenerate')}
        </Button>
      </div>

      <div className="space-y-2 rounded-md border border-destructive/40 p-4">
        <p className="text-sm text-muted-foreground">{t('disableIntro')}</p>
        <div className="flex gap-2">
          <Input
            id="disable-code"
            placeholder={t('codePlaceholder')}
            value={disableCode}
            onChange={(e) => setDisableCode(e.target.value)}
            className="font-mono"
          />
          <Button
            variant="destructive"
            onClick={onDisable}
            disabled={pending || disableCode.length < 6}
          >
            {pending ? t('disabling') : t('disable')}
          </Button>
        </div>
      </div>
    </div>
  );
}
