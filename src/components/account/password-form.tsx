'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { changePasswordAction } from '@/lib/account/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const schema = z
  .object({
    currentPassword: z.string().min(8).max(128),
    newPassword: z.string().min(8).max(128),
    confirm: z.string().min(8).max(128),
  })
  .refine((v) => v.newPassword === v.confirm, {
    path: ['confirm'],
    message: 'mismatch',
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ['newPassword'],
    message: 'reuse',
  });

type Values = z.infer<typeof schema>;

export function PasswordForm() {
  const t = useTranslations('account.security');
  const [pending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = (values: Values) => {
    startTransition(async () => {
      const result = await changePasswordAction({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      if (result.ok) {
        // 服务器操作已经触发 signOut → redirect；除非重定向在开发中被拦截，
        // 否则我们永远不会到达这里。以防万一重置。
        reset();
        toast.success(t('saved'));
        return;
      }
      const map: Record<string, string> = {
        'wrong-password': t('errors.wrongPassword'),
        'no-password': t('errors.noPassword'),
        'invalid-input': t('errors.invalidInput'),
      };
      toast.error(map[result.error] ?? t('errors.generic'));
    });
  };

  const messageFor = (msg: string | undefined, fallback: string | undefined) => {
    if (!msg) return fallback;
    if (msg === 'mismatch') return t('errors.mismatch');
    if (msg === 'reuse') return t('errors.reuse');
    return msg;
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="currentPassword">{t('fields.current')}</Label>
        <Input
          id="currentPassword"
          type="password"
          autoComplete="current-password"
          {...register('currentPassword')}
        />
        {errors.currentPassword ? (
          <p className="text-xs text-destructive">{errors.currentPassword.message}</p>
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor="newPassword">{t('fields.new')}</Label>
        <Input
          id="newPassword"
          type="password"
          autoComplete="new-password"
          {...register('newPassword')}
        />
        {errors.newPassword ? (
          <p className="text-xs text-destructive">
            {messageFor(errors.newPassword.message, undefined)}
          </p>
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm">{t('fields.confirm')}</Label>
        <Input id="confirm" type="password" autoComplete="new-password" {...register('confirm')} />
        {errors.confirm ? (
          <p className="text-xs text-destructive">
            {messageFor(errors.confirm.message, undefined)}
          </p>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      <Button type="submit" disabled={pending}>
        {pending ? t('saving') : t('save')}
      </Button>
    </form>
  );
}
