'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { resetPasswordAction } from '@/lib/auth/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';

/**
 * 重置密码表单验证 schema。
 * 要求密码长度在 8-128 字符之间，且两次输入密码必须相同。
 */
const schema = z
  .object({
    password: z.string().min(8).max(128),
    confirm: z.string().min(8).max(128),
  })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'mismatch',
  });

type Values = z.infer<typeof schema>;

/**
 * 重置密码表单组件的 props 接口。
 *
 * @property token - 密码重置令牌，通常来自邮件中的链接查询参数。
 */
interface Props {
  token: string;
}

/**
 * 重置密码表单组件。
 *
 * 允许用户在点击邮件中的重置链接后，输入新密码并确认。表单验证确保
 * 两次密码输入一致，重置成功后自动跳转到登录页面。
 *
 * @param props - 组件 props，包含 token。
 * @returns 包含密码和确认密码输入字段的表单。
 */
export function ResetPasswordForm({ token }: Props) {
  const t = useTranslations('auth.resetPassword');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = (values: Values) => {
    startTransition(async () => {
      const result = await resetPasswordAction({ token, password: values.password });
      if (result.ok) {
        // 重置成功，显示成功提示并跳转到登录页
        toast.success(t('success'));
        router.replace('/login');
        router.refresh();
        return;
      }
      // 构建错误信息 key，处理不同的错误类型
      const key = `errors.${result.error}` as
        | 'errors.invalid'
        | 'errors.expired'
        | 'errors.invalid-input';
      toast.error(t(key));
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="password">{t('fields.password')}</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          {...register('password')}
        />
        {errors.password ? (
          <p className="text-xs text-destructive">{errors.password.message}</p>
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm">{t('fields.confirm')}</Label>
        <Input id="confirm" type="password" autoComplete="new-password" {...register('confirm')} />
        {errors.confirm ? (
          <p className="text-xs text-destructive">
            {errors.confirm.message === 'mismatch' ? t('errors.mismatch') : errors.confirm.message}
          </p>
        ) : null}
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t('submitting') : t('submit')}
      </Button>
    </form>
  );
}
