'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { deleteAccountAction } from '@/services/account/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * DangerZone 组件 Props
 * @property {string} email - 用户邮箱地址
 */
interface Props {
  email: string;
}

/**
 * 用户账户删除危险区域组件
 * 提供账户删除功能，需要邮箱确认。删除后将通过 server action 清除登录状态并重定向。
 * @param {Props} props
 * @returns 账户删除界面
 */
export function DangerZone({ email }: Props) {
  const t = useTranslations('account.danger');
  const [pending, startTransition] = useTransition();
  const [confirmEmail, setConfirmEmail] = useState('');

  // 验证用户输入的邮箱是否与账户邮箱匹配
  const matches = confirmEmail.trim().toLowerCase() === email.toLowerCase();

  /**
   * 删除用户账户
   */
  const onDelete = () => {
    if (!matches) return;
    if (!confirm(t('confirmDialog'))) return;
    startTransition(async () => {
      // 调用服务端 action 删除账户，signOut 和重定向在服务端处理
      const result = await deleteAccountAction({ emailConfirm: confirmEmail });
      if (result.ok) {
        return;
      }
      if (result.error === 'owns-orgs') {
        toast.error(
          t('errors.ownsOrgs', {
            count: result.orgs.length,
            names: result.orgs.map((o) => o.name).join(', '),
          }),
        );
        return;
      }
      const map: Record<string, string> = {
        'email-mismatch': t('errors.emailMismatch'),
        'invalid-input': t('errors.invalidInput'),
      };
      toast.error(map[result.error] ?? t('errors.generic'));
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <div className="space-y-2">
        <Label htmlFor="confirmEmail">{t('confirmLabel', { email })}</Label>
        <Input
          id="confirmEmail"
          type="email"
          autoComplete="off"
          value={confirmEmail}
          onChange={(e) => setConfirmEmail(e.target.value)}
          placeholder={email}
        />
      </div>
      <Button variant="destructive" disabled={!matches || pending} onClick={onDelete}>
        {pending ? t('working') : t('action')}
      </Button>
    </div>
  );
}
