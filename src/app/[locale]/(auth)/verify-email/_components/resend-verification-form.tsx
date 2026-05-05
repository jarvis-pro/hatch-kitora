'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { requestEmailVerificationAction } from '@/lib/auth/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * 邮件验证重发表单验证 schema。
 * 要求输入有效的电子邮箱地址。
 */
const schema = z.object({
  email: z.string().email(),
});

type Values = z.infer<typeof schema>;

/**
 * 邮件验证重发表单组件。
 *
 * 允许用户重新请求发送邮箱验证链接。用户输入邮箱后，
 * 后台会发送新的验证邮件。成功后显示确认提示。
 * 支持限流保护，频繁请求会返回 rate-limited 错误。
 *
 * @returns 包含邮箱输入字段和提交按钮的表单，或已发送确认消息。
 */
export function ResendVerificationForm() {
  const t = useTranslations('auth.verifyEmail');
  const [pending, startTransition] = useTransition();
  const [sent, setSent] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = (values: Values) => {
    startTransition(async () => {
      const result = await requestEmailVerificationAction(values);
      if (result.ok) {
        // 验证邮件发送成功，显示确认提示
        setSent(true);
        toast.success(t('resend.sent'));
      } else if (result.error === 'rate-limited') {
        toast.error(t('errors.rate-limited'));
      } else {
        toast.error(t('errors.invalid-input'));
      }
    });
  };

  // 邮件已发送，显示确认提示
  if (sent) {
    return (
      <div className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
        {t('resend.sentDetail')}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">{t('fields.email')}</Label>
        <Input id="email" type="email" autoComplete="email" {...register('email')} />
        {errors.email ? <p className="text-xs text-destructive">{errors.email.message}</p> : null}
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t('resend.submitting') : t('resend.submit')}
      </Button>
    </form>
  );
}
