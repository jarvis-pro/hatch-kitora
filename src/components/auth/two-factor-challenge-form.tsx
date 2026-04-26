'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { verifyTfaForCurrentSessionAction } from '@/lib/account/two-factor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';

const schema = z.object({
  // Accept TOTP (6 digits) and backup codes (8 alphanumerics, optional dash).
  // Server-side validation does the strict check; this is just to fail fast.
  code: z.string().min(6).max(20),
});

type Values = z.infer<typeof schema>;

interface Props {
  callbackUrl: string;
}

export function TwoFactorChallengeForm({ callbackUrl }: Props) {
  const t = useTranslations('auth.twoFactorChallenge');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = (values: Values) => {
    startTransition(async () => {
      const result = await verifyTfaForCurrentSessionAction({ code: values.code });
      if (result.ok) {
        // The JWT update happens in the action; redirect now and let the
        // RSC re-render with `tfaPending = false`. router.refresh() forces
        // the layout to re-run getServerSession.
        router.replace(callbackUrl as '/dashboard');
        router.refresh();
        return;
      }
      toast.error(
        result.error === 'wrong-code'
          ? t('errors.wrongCode')
          : result.error === 'not-enabled'
            ? t('errors.notEnabled')
            : t('errors.generic'),
      );
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="code">{t('fields.code')}</Label>
        <Input
          id="code"
          inputMode="text"
          autoComplete="one-time-code"
          autoFocus
          placeholder={t('placeholder')}
          {...register('code')}
        />
        {errors.code ? <p className="text-xs text-destructive">{errors.code.message}</p> : null}
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t('submitting') : t('submit')}
      </Button>
    </form>
  );
}
