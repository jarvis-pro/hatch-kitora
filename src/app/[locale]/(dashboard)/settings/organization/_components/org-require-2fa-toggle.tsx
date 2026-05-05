'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { toggleOrgRequire2faAction } from '@/services/orgs/two-factor-policy';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/routing';

interface Props {
  orgSlug: string;
  enabled: boolean;
}

/**
 * RFC 0002 PR-4 — 仅限 OWNER 的开关，用于对每个成员强制执行 2FA。
 *
 * "你必须先拥有 2FA 才能启用它" 的检查在服务器操作中；
 * 此 UI 使用裁定的 `caller-needs-2fa` 错误显示提示。
 */
export function OrgRequire2faToggle({ orgSlug, enabled }: Props) {
  const t = useTranslations('orgs.require2fa');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const onToggle = () => {
    startTransition(async () => {
      const result = await toggleOrgRequire2faAction({
        orgSlug,
        require2fa: !enabled,
      });
      if (result.ok) {
        toast.success(enabled ? t('disabled') : t('enabled'));
        router.refresh();
        return;
      }
      if (result.error === 'caller-needs-2fa') {
        toast.error(t('errors.callerNeeds2fa'));
        return;
      }
      toast.error(t('errors.generic'));
    });
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {enabled ? t('descriptionEnabled') : t('descriptionDisabled')}
      </p>
      <Button variant={enabled ? 'outline' : 'default'} onClick={onToggle} disabled={pending}>
        {pending ? t('working') : enabled ? t('disable') : t('enable')}
      </Button>
    </div>
  );
}
