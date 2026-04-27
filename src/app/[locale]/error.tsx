'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors.runtime');

  useEffect(() => {
    // 转发到 Sentry（当 DSN 未设置时为无操作），并为网络面板可能
    // 未打开的本地 dev 保留控制台行。
    Sentry.captureException(error);
    console.error('[unhandled-error]', { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
      <p className="max-w-md text-muted-foreground">{t('description')}</p>
      <Button onClick={reset}>{t('cta')}</Button>
    </div>
  );
}
