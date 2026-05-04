'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { setUserRoleAction } from '@/services/admin/actions';
import { cn } from '@/lib/utils';

/**
 * 角色选择下拉框组件的 props 接口。
 *
 * @property userId - 要修改角色的用户 ID。
 * @property currentRole - 用户当前的角色，值为 'USER' 或 'ADMIN'。
 * @property disabled - 可选，当为 true 时禁用该下拉框（如当前登录用户是该管理员本人时）。
 */
interface RoleSelectProps {
  userId: string;
  currentRole: 'USER' | 'ADMIN';
  disabled?: boolean;
}

/**
 * 用户角色选择下拉框组件。
 *
 * 允许管理员为用户切换 USER/ADMIN 角色。选择变更时会触发后台异步操作，
 * 并通过 toast 提示操作结果。当 disabled 为真或请求进行中，该下拉框会禁用。
 *
 * @param props - 组件 props，包含 userId、currentRole 和 disabled。
 * @returns 原生 select 下拉框元素，包含 USER 和 ADMIN 两个选项。
 */
export function RoleSelect({ userId, currentRole, disabled }: RoleSelectProps) {
  const t = useTranslations('admin.users');
  const [pending, startTransition] = useTransition();

  const onChange = (role: 'USER' | 'ADMIN') => {
    // 如果选中的角色与当前角色相同，无需提交
    if (role === currentRole) return;
    startTransition(async () => {
      const result = await setUserRoleAction({ userId, role });
      if (result.ok) {
        toast.success(t('roleUpdated'));
      } else if (result.error === 'self-demote') {
        // 防止自我降权
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
