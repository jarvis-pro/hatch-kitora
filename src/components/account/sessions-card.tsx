'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { signOutEverywhereAction } from '@/lib/account/actions';
import { Button } from '@/components/ui/button';

export function SessionsCard() {
  const t = useTranslations('account.sessions');
  const [pending, startTransition] = useTransition();

  const onClick = () => {
    if (!confirm(t('confirm'))) return;
    startTransition(async () => {
      const result = await signOutEverywhereAction();
      if (!result.ok) {
        toast.error(t('errors.generic'));
      }
      // 成功后 action 触发 signOut → 重定向到 /login。
    });
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <Button variant="outline" onClick={onClick} disabled={pending}>
        {pending ? t('working') : t('action')}
      </Button>
    </div>
  );
}
