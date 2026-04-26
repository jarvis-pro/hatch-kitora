'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { cancelAccountDeletionAction } from '@/lib/account/actions';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/routing';

interface Props {
  scheduledAt: Date;
}

/**
 * RFC 0002 PR-4 — top-of-page banner shown to users in PENDING_DELETION
 * across the dashboard layout (mounted once in the dashboard layout).
 * Single CTA: "Cancel deletion" → flips status back to ACTIVE.
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
