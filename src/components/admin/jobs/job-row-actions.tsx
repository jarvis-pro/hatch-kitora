'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/routing';
import { cancelJobAction, retryJobAction } from '@/lib/admin/actions';

interface Props {
  jobId: string;
}

/**
 * RFC 0008 §4.8 / PR-4 — DEAD_LETTER 行手动救援按钮组。
 *
 * 两个互斥操作：
 *   - **Retry** —— 翻回 PENDING + 重置 attempt，下一 tick 再试；前提是 admin
 *     已修复根因（数据 / 外部依赖）。
 *   - **Cancel** —— 翻 CANCELED 归档，承认任务已彻底失败、不需要再处理。
 *
 * 双 confirm()：retry 是建设性操作（不需要确认），cancel 是终态操作（确认一次）。
 */
export function JobRowActions({ jobId }: Props) {
  const t = useTranslations('admin.jobs.actions');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onRetry() {
    startTransition(async () => {
      const result = await retryJobAction({ jobId });
      if (result.ok) {
        toast.success(t('retrySuccess'));
        router.refresh();
      } else {
        toast.error(t('retryError'));
      }
    });
  }

  function onCancel() {
    if (!confirm(t('cancelConfirm'))) return;
    startTransition(async () => {
      const result = await cancelJobAction({ jobId });
      if (result.ok) {
        toast.success(t('cancelSuccess'));
        router.refresh();
      } else {
        toast.error(t('cancelError'));
      }
    });
  }

  return (
    <div className="flex gap-2">
      <Button size="sm" variant="outline" onClick={onRetry} disabled={pending}>
        {t('retry')}
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
        {t('cancel')}
      </Button>
    </div>
  );
}
