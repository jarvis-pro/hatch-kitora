'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { toggleOrgRequire2faAction } from '@/lib/orgs/two-factor-policy';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/routing';

interface Props {
  orgSlug: string;
  enabled: boolean;
}

/**
 * RFC 0002 PR-4 — OWNER-only switch to enforce 2FA on every member.
 *
 * The "you must have 2FA yourself before turning it on" check is in the
 * server action; this UI surfaces the resulting `caller-needs-2fa` error
 * with a tailored toast.
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
