'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { updateProfileAction } from '@/services/account/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';

/**
 * 用户资料表单验证 schema
 */
const schema = z.object({
  name: z.string().min(1).max(80),
});

/**
 * 表单数据类型
 */
type Values = z.infer<typeof schema>;

/**
 * ProfileForm 组件 Props
 * @property {string} defaultName - 初始用户昵称
 * @property {string} email - 用户邮箱地址（只读）
 */
interface Props {
  defaultName: string;
  email: string;
}

/**
 * 用户资料编辑表单组件
 * 允许用户修改昵称。邮箱地址显示但禁用编辑（如需修改需要额外的验证流程）。
 * @param {Props} props
 * @returns 用户资料编辑表单
 */
export function ProfileForm({ defaultName, email }: Props) {
  const t = useTranslations('account.profile');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: defaultName },
  });

  /**
   * 提交用户资料表单
   */
  const onSubmit = (values: Values) => {
    startTransition(async () => {
      // 调用服务端 action 更新用户资料
      const result = await updateProfileAction(values);
      if (result.ok) {
        toast.success(t('saved'));
        router.refresh();
      } else {
        toast.error(t('errors.generic'));
      }
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">{t('fields.email')}</Label>
        <Input id="email" type="email" value={email} disabled readOnly />
        <p className="text-xs text-muted-foreground">{t('emailHint')}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="name">{t('fields.name')}</Label>
        <Input id="name" autoComplete="name" {...register('name')} />
        {errors.name ? <p className="text-xs text-destructive">{errors.name.message}</p> : null}
      </div>
      <Button type="submit" disabled={pending || !isDirty}>
        {pending ? t('saving') : t('save')}
      </Button>
    </form>
  );
}
