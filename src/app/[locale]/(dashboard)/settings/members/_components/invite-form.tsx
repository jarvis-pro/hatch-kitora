'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { OrgRole } from '@prisma/client';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';
import { createInvitationAction } from '@/services/orgs/invitations';

/**
 * 邀请表单验证 schema
 */
const schema = z.object({
  email: z.string().email(),
  role: z.enum([OrgRole.ADMIN, OrgRole.MEMBER]),
});

/**
 * 表单数据类型
 */
type Values = z.infer<typeof schema>;

/**
 * 组织成员邀请表单组件
 * 允许 ADMIN/OWNER 邀请新用户加入组织，支持指定角色（MEMBER/ADMIN）。
 * 邀请后发送邮件给被邀请者。
 * @returns 邀请表单
 */
export function InviteForm() {
  const t = useTranslations('orgs.members.invite');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { role: OrgRole.MEMBER },
  });

  /**
   * 提交邀请表单
   */
  const onSubmit = (values: Values) => {
    startTransition(async () => {
      // 调用服务端 action 创建邀请
      const result = await createInvitationAction(values);
      if (!result.ok) {
        const errKey = `errors.${result.error}` as const;
        toast.error(t(errKey, { fallback: t('errors.generic') }));
        return;
      }
      // 邀请成功，重置表单并刷新页面
      toast.success(t('sent'));
      reset({ email: '', role: OrgRole.MEMBER });
      router.refresh();
    });
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="flex flex-col gap-3 sm:flex-row sm:items-end"
    >
      <div className="flex-1 space-y-2">
        <Label htmlFor="invite-email">{t('emailLabel')}</Label>
        <Input
          id="invite-email"
          type="email"
          autoComplete="off"
          placeholder={t('emailPlaceholder')}
          {...register('email')}
        />
        {errors.email ? (
          <p className="text-xs text-destructive">{t('errors.invalid-input')}</p>
        ) : null}
      </div>
      <div className="space-y-2 sm:w-36">
        <Label htmlFor="invite-role">{t('roleLabel')}</Label>
        <select
          id="invite-role"
          {...register('role')}
          className="block h-10 w-full rounded-md border bg-background px-2 text-sm"
        >
          <option value={OrgRole.MEMBER}>{t('roles.MEMBER')}</option>
          <option value={OrgRole.ADMIN}>{t('roles.ADMIN')}</option>
        </select>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? t('sending') : t('submit')}
      </Button>
    </form>
  );
}
