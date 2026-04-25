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
    // Forward to Sentry (no-op when DSN unset) and keep the console line for
    // local dev where the network panel might not be open.
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
