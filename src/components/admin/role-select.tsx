'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { setUserRoleAction } from '@/lib/admin/actions';
import { cn } from '@/lib/utils';

interface RoleSelectProps {
  userId: string;
  currentRole: 'USER' | 'ADMIN';
  /** When true, renders disabled (e.g. the row is the current admin themselves). */
  disabled?: boolean;
}

export function RoleSelect({ userId, currentRole, disabled }: RoleSelectProps) {
  const t = useTranslations('admin.users');
  const [pending, startTransition] = useTransition();

  const onChange = (role: 'USER' | 'ADMIN') => {
    if (role === currentRole) return;
    startTransition(async () => {
      const result = await setUserRoleAction({ userId, role });
      if (result.ok) {
        toast.success(t('roleUpdated'));
      } else if (result.error === 'self-demote') {
        toast.error(t('errors.selfDemote'));
      } else {
        toast.error(t('errors.generic'));
      }
    });
  };

  return (
    <select
      defaultValue={currentRole}
      onChange={(e) => onChange(e.target.value as 'USER' | 'ADMIN')}
      disabled={disabled || pending}
      className={cn(
        'rounded-md border bg-background px-2 py-1 text-xs',
        (disabled || pending) && 'opacity-60',
      )}
      aria-label={t('roleLabel')}
    >
      <option value="USER">{t('role.user')}</option>
      <option value="ADMIN">{t('role.admin')}</option>
    </select>
  );
}
