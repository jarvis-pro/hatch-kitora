'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { signupAction } from '@/lib/auth/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';

/**
 * 注册表单验证 schema。
 * 要求输入用户名（1-80 字符）、有效邮箱和密码（8-128 字符）。
 */
const schema = z.object({
  name: z.string().min(1).max(80),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

type Values = z.infer<typeof schema>;

/**
 * 用户注册表单组件。
 *
 * 允许新用户输入用户名、邮箱和密码进行注册。注册成功后根据
 * `requiresLogin` 标志决定跳转至登录页或仪表板。若邮箱已被注册，
 * 会返回相应错误提示。
 *
 * @returns 包含用户名、邮箱、密码输入字段和提交按钮的表单。
 */
export function SignupForm() {
  const t = useTranslations('auth.signup');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = (values: Values) => {
    startTransition(async () => {
      const result = await signupAction(values);
      if (result.ok) {
        toast.success(t('success'));
        // 注册成功后，根据是否需要登录来决定跳转目标
        router.replace(result.requiresLogin ? '/login' : '/dashboard');
        router.refresh();
      } else {
        toast.error(t(`errors.${result.error}` as 'errors.email-taken' | 'errors.invalid-input'));
      }
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">{t('fields.name')}</Label>
        <Input id="name" autoComplete="name" {...register('name')} />
        {errors.name ? <p className="text-xs text-destructive">{errors.name.message}</p> : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">{t('fields.email')}</Label>
        <Input id="email" type="email" autoComplete="email" {...register('email')} />
        {errors.email ? <p className="text-xs text-destructive">{errors.email.message}</p> : null}
      </div>
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
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t('submitting') : t('submit')}
      </Button>
    </form>
  );
}
