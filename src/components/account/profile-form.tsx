'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { updateProfileAction } from '@/lib/account/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';

const schema = z.object({
  name: z.string().min(1).max(80),
});

type Values = z.infer<typeof schema>;

interface Props {
  defaultName: string;
  email: string;
}

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

  const onSubmit = (values: Values) => {
    startTransition(async () => {
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
