/**
 * Next.js instrumentation hook — required by @sentry/nextjs to wire the
 * server / edge SDK at process boot.
 *
 * Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

// Sentry exports the helper as `captureRequestError`; Next.js looks for
// `onRequestError`. Re-export under the expected name.
export { captureRequestError as onRequestError } from '@sentry/nextjs';
