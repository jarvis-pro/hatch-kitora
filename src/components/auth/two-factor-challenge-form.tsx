'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { verifyTfaForCurrentSessionAction } from '@/services/account/two-factor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';

const schema = z.object({
  // 接受 TOTP（6 位数字）和备份码（8 个字母数字，可选连字符）。
  // 服务器端验证进行严格检查；这只是快速失败。
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
        // JWT 更新发生在操作中；现在重定向并让
        // RSC 使用 `tfaPending = false` 重新呈现。router.refresh() 强制
        // 布局重新运行 getServerSession。
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
