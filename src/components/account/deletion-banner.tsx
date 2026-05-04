'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { cancelAccountDeletionAction } from '@/services/account/actions';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/routing';

interface Props {
  scheduledAt: Date;
}

/**
 * RFC 0002 PR-4 — 显示在仪表板布局顶部的横幅，对处于 PENDING_DELETION
 * 状态的用户显示（在仪表板布局中挂载一次）。
 * 单个 CTA："取消删除" → 将状态改回 ACTIVE。
 */
export function DeletionBanner({ scheduledAt }: Props) {
  const t = useTranslations('account.deletion.banner');
  const format = useFormatter();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const onCancel = () => {
    startTransition(async () => {
      const result = await cancelAccountDeletionAction();
      if (result.ok) {
        toast.success(t('cancelled'));
        router.refresh();
      } else {
        toast.error(t('error'));
      }
    });
  };

  return (
    <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-3">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-destructive">
          {t('message', {
            date: format.dateTime(scheduledAt, { dateStyle: 'long' }),
          })}
        </p>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={pending}>
          {pending ? t('cancelling') : t('cancel')}
        </Button>
      </div>
    </div>
  );
}
