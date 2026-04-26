'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/routing';
import { acceptInvitationAction } from '@/lib/orgs/invitations';

interface Props {
  token: string;
}

export function InviteAcceptButton({ token }: Props) {
  const t = useTranslations('orgs.invite');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const onAccept = () => {
    startTransition(async () => {
      const result = await acceptInvitationAction({ token });
      if (!result.ok) {
        if (result.error === 'wrong-email') {
          toast.error(
            t('errors.wrong-email', {
              email: 'expectedEmail' in result ? result.expectedEmail : '',
            }),
          );
        } else {
          toast.error(
            t(`errors.${result.error}` as 'errors.invalid', { fallback: t('errors.generic') }),
          );
        }
        return;
      }
      toast.success(t('accepted'));
      router.push('/dashboard');
      router.refresh();
    });
  };

  return (
    <Button onClick={onAccept} disabled={pending} className="w-full">
      {pending ? t('accepting') : t('accept')}
    </Button>
  );
}
