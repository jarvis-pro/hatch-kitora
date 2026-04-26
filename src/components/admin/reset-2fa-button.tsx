'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { resetUserTwoFactorAction } from '@/lib/admin/actions';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/routing';

interface Props {
  userId: string;
  enabled: boolean;
}

/**
 * Platform-admin "Reset 2FA" — used during the recovery path when a user
 * has lost both their authenticator and all backup codes. Confirmed via
 * native confirm() to avoid an accidental click.
 */
export function Reset2faButton({ userId, enabled }: Props) {
  const t = useTranslations('admin.users.reset2fa');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (!enabled) {
    return <span className="text-xs text-muted-foreground">{t('off')}</span>;
  }

  const onClick = () => {
    if (!confirm(t('confirm'))) return;
    startTransition(async () => {
      const result = await resetUserTwoFactorAction({ userId });
      if (result.ok) {
        toast.success(t('done'));
        router.refresh();
      } else {
        toast.error(t('error'));
      }
    });
  };

  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={pending}>
      {pending ? t('working') : t('action')}
    </Button>
  );
}
