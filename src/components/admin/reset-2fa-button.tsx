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
 * 平台管理员 "重置 2FA" — 在恢复路径中使用，当用户
 * 同时丢失了身份验证器和所有备份码。通过原生 confirm() 确认
 * 以避免意外点击。
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
