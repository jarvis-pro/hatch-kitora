'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { startRegistration } from '@simplewebauthn/browser';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';

/**
 * RFC 0007 PR-2 — "Add a passkey" CTA on `/settings/security/passkeys`.
 *
 * Two-stage UI:
 *   1. Click "Add a passkey" → reveal name input + confirm.
 *   2. Submit name → POST /options → startRegistration() → POST /verify
 *      → router.refresh() so the RSC list picks up the new row.
 *
 * No QR / device-picker UI here — the OS / browser owns that step.
 */
export function RegisterPasskeyButton() {
  const t = useTranslations('account.passkeys');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [pending, startTransition] = useTransition();

  function handleAdd() {
    if (!name.trim()) {
      toast.error(t('errors.nameRequired'));
      return;
    }
    startTransition(async () => {
      try {
        const optionsRes = await fetch('/api/auth/webauthn/register/options', { method: 'POST' });
        if (!optionsRes.ok) {
          toast.error(t('errors.optionsFailed'));
          return;
        }
        const options = await optionsRes.json();

        // Browser ceremony — user touches sensor / inserts key.
        const attestation = await startRegistration({ optionsJSON: options });

        const verifyRes = await fetch('/api/auth/webauthn/register/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ response: attestation, name: name.trim() }),
        });
        const result = (await verifyRes.json()) as { ok?: boolean; error?: string };
        if (!verifyRes.ok || !result.ok) {
          toast.error(t('errors.verifyFailed'));
          return;
        }

        toast.success(t('addSuccess'));
        setOpen(false);
        setName('');
        router.refresh();
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown';
        // User-aborted ceremonies throw `NotAllowedError` — soft-fail.
        if (msg.includes('NotAllowedError') || msg.includes('cancelled')) return;
        toast.error(t('errors.unknown'));
      }
    });
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} variant="default">
        {t('addCta')}
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-4">
      <Label htmlFor="passkey-name">{t('nameLabel')}</Label>
      <Input
        id="passkey-name"
        autoFocus
        placeholder={t('namePlaceholder')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={80}
      />
      <div className="flex gap-2">
        <Button onClick={handleAdd} disabled={pending}>
          {pending ? t('adding') : t('confirmAdd')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setName('');
          }}
          disabled={pending}
        >
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}
