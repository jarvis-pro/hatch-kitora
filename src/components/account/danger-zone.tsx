'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { deleteAccountAction } from '@/lib/account/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Props {
  email: string;
}

export function DangerZone({ email }: Props) {
  const t = useTranslations('account.danger');
  const [pending, startTransition] = useTransition();
  const [confirmEmail, setConfirmEmail] = useState('');

  const matches = confirmEmail.trim().toLowerCase() === email.toLowerCase();

  const onDelete = () => {
    if (!matches) return;
    if (!confirm(t('confirmDialog'))) return;
    startTransition(async () => {
      const result = await deleteAccountAction({ emailConfirm: confirmEmail });
      if (result.ok) {
        // signOut + redirect handled in action.
        return;
      }
      if (result.error === 'owns-orgs') {
        toast.error(
          t('errors.ownsOrgs', {
            count: result.orgs.length,
            names: result.orgs.map((o) => o.name).join(', '),
          }),
        );
        return;
      }
      const map: Record<string, string> = {
        'email-mismatch': t('errors.emailMismatch'),
        'invalid-input': t('errors.invalidInput'),
      };
      toast.error(map[result.error] ?? t('errors.generic'));
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <div className="space-y-2">
        <Label htmlFor="confirmEmail">{t('confirmLabel', { email })}</Label>
        <Input
          id="confirmEmail"
          type="email"
          autoComplete="off"
          value={confirmEmail}
          onChange={(e) => setConfirmEmail(e.target.value)}
          placeholder={email}
        />
      </div>
      <Button variant="destructive" disabled={!matches || pending} onClick={onDelete}>
        {pending ? t('working') : t('action')}
      </Button>
    </div>
  );
}
