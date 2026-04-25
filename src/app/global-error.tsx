'use client';

import * as Sentry from '@sentry/nextjs';
import NextError from 'next/error';
import { useEffect } from 'react';

/**
 * Top-level error boundary — only triggers when an error escapes every
 * locale-scoped error.tsx, e.g. failures in `[locale]/layout.tsx` itself.
 * Must render its own <html><body> because the failing layout is gone.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
