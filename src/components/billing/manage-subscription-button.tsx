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
 * POST 到 /api/stripe/portal 并重定向浏览器到返回的 URL。
 * Stripe 在托管门户中处理计划更改 / 取消 / 发票。
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
