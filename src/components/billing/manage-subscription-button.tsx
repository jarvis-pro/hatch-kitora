'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

interface Props {
  variant?: 'default' | 'outline';
  className?: string;
}

/**
 * POSTs to /api/stripe/portal and redirects the browser to the returned URL.
 * Stripe handles plan changes / cancellation / invoices on the hosted portal.
 */
export function ManageSubscriptionButton({ variant = 'default', className }: Props) {
  const t = useTranslations('billing');
  const [pending, startTransition] = useTransition();

  const onClick = () => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/stripe/portal', { method: 'POST' });
        const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!res.ok || !data.url) {
          toast.error(t('errors.portal'));
          return;
        }
        window.location.href = data.url;
      } catch {
        toast.error(t('errors.portal'));
      }
    });
  };

  return (
    <Button variant={variant} onClick={onClick} disabled={pending} className={className}>
      {pending ? t('manage.opening') : t('manage.cta')}
    </Button>
  );
}
