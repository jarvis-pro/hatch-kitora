'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';
import { updateOrgAction } from '@/lib/orgs/actions';

const schema = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/, 'invalid-slug'),
});

type Values = z.infer<typeof schema>;

interface Props {
  defaultName: string;
  defaultSlug: string;
}

export function OrgSettingsForm({ defaultName, defaultSlug }: Props) {
  const t = useTranslations('orgs.settings');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: defaultName, slug: defaultSlug },
  });

  const onSubmit = (values: Values) => {
    startTransition(async () => {
      const result = await updateOrgAction(values);
      if (!result.ok) {
        const errKey = `errors.${result.error}` as const;
        toast.error(t(errKey, { fallback: t('errors.generic') }));
        return;
      }
      toast.success(t('saved'));
      router.refresh();
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="org-name">{t('fields.name')}</Label>
        <Input id="org-name" {...register('name')} maxLength={80} />
        {errors.name ? <p className="text-xs text-destructive">{errors.name.message}</p> : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor="org-slug">{t('fields.slug')}</Label>
        <Input id="org-slug" {...register('slug')} maxLength={40} />
        <p className="text-xs text-muted-foreground">{t('slugHint')}</p>
        {errors.slug ? (
          <p className="text-xs text-destructive">{t('errors.invalid-slug')}</p>
        ) : null}
      </div>
      <Button type="submit" disabled={pending || !isDirty}>
        {pending ? t('saving') : t('save')}
      </Button>
    </form>
  );
}
