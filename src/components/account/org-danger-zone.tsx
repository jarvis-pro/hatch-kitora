'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';
import { deleteOrgAction } from '@/lib/orgs/actions';

interface Props {
  orgSlug: string;
}

export function OrgDangerZone({ orgSlug }: Props) {
  const t = useTranslations('orgs.danger');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState('');

  const onDelete = () => {
    if (confirm !== orgSlug) {
      toast.error(t('errors.slug-mismatch'));
      return;
    }
    if (!window.confirm(t('finalConfirm'))) return;

    startTransition(async () => {
      const result = await deleteOrgAction({ slugConfirm: confirm });
      if (!result.ok) {
        toast.error(t(`errors.${result.error}` as 'errors.generic') || t('errors.generic'));
        return;
      }
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
