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

interface Props {
  token: string;
}

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
        toast.success(t('success'));
        router.replace('/login');
        router.refresh();
        return;
      }
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
