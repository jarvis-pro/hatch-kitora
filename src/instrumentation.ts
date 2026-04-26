/**
 * Next.js instrumentation hook — wires up Sentry SDKs at process boot.
 *
 * Note: the `CredentialsSignin` stderr filter lives in a Node `--require`
 * preload (`scripts/silence-auth-noise.cjs`), not here — `register()` runs
 * after Next.js's logger has already captured its stderr stream.
 *
 * Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
    // RFC 0005 — fail-fast region check. If the deploy region this
    // process believes it's serving disagrees with what's already in the
    // database, refuse to come up: a CN stack must never write GLOBAL
    // rows or vice-versa. The check runs only on the Node runtime — Edge
    // can't open a Prisma connection — and only as a soft assertion;
    // first-boot databases (no orgs yet) sail through.
    await import('@/lib/region-startup-check').then((m) => m.assertRegionMatchesDatabase());
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

// Sentry exports the helper as `captureRequestError`; Next.js looks for
// `onRequestError`. Re-export under the expected name.
export { captureRequestError as onRequestError } from '@sentry/nextjs';
