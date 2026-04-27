'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/routing';
import { acceptInvitationAction } from '@/lib/orgs/invitations';

/**
 * InviteAcceptButton 组件 Props
 * @property {string} token - 邀请令牌
 */
interface Props {
  token: string;
}

/**
 * 邀请接受按钮组件
 * 用户点击邀请链接后接受组织邀请，验证邮箱匹配性，成功后跳转到仪表板。
 * @param {Props} props
 * @returns 接受邀请按钮
 */
export function InviteAcceptButton({ token }: Props) {
  const t = useTranslations('orgs.invite');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  /**
   * 接受组织邀请
   */
  const onAccept = () => {
    startTransition(async () => {
      // 调用服务端 action 接受邀请
      const result = await acceptInvitationAction({ token });
      if (!result.ok) {
        // 处理邮箱不匹配错误
        if (result.error === 'wrong-email') {
          toast.error(
            t('errors.wrong-email', {
              email: 'expectedEmail' in result ? result.expectedEmail : '',
            }),
          );
        } else {
          toast.error(
            t(`errors.${result.error}` as 'errors.invalid', { fallback: t('errors.generic') }),
          );
        }
        return;
      }
      // 邀请接受成功，跳转到仪表板
      toast.success(t('accepted'));
      router.push('/dashboard');
      router.refresh();
    });
  };

  return (
    <Button onClick={onAccept} disabled={pending} className="w-full">
      {pending ? t('accepting') : t('accept')}
    </Button>
  );
}
