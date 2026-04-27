'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';
import { deleteOrgAction } from '@/lib/orgs/actions';

/**
 * OrgDangerZone 组件 Props
 * @property {string} orgSlug - 组织 slug
 */
interface Props {
  orgSlug: string;
}

/**
 * 组织删除危险区域组件
 * 仅 OWNER 可删除整个组织，需要确认 slug 匹配以及最终确认对话框。
 * 删除后跳转回仪表板。
 * @param {Props} props
 * @returns 组织删除界面
 */
export function OrgDangerZone({ orgSlug }: Props) {
  const t = useTranslations('orgs.danger');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState('');

  /**
   * 删除组织
   */
  const onDelete = () => {
    // 验证输入的 slug 是否匹配
    if (confirm !== orgSlug) {
      toast.error(t('errors.slug-mismatch'));
      return;
    }
    // 最终确认对话框
    if (!window.confirm(t('finalConfirm'))) return;

    startTransition(async () => {
      // 调用服务端 action 删除组织
      const result = await deleteOrgAction({ slugConfirm: confirm });
      if (!result.ok) {
        toast.error(t(`errors.${result.error}` as 'errors.generic') || t('errors.generic'));
        return;
      }
      // 删除成功，返回仪表板
      toast.success(t('deleted'));
      router.push('/dashboard');
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <div className="space-y-2">
        <Label htmlFor="delete-org-confirm">{t('confirmLabel', { slug: orgSlug })}</Label>
        <Input
          id="delete-org-confirm"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={orgSlug}
        />
      </div>
      <Button variant="destructive" onClick={onDelete} disabled={pending || confirm !== orgSlug}>
        {pending ? t('deleting') : t('delete')}
      </Button>
    </div>
  );
}
