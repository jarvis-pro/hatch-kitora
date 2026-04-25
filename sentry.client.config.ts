/**
 * Sentry client-side configuration.
 *
 * Loaded by `@sentry/nextjs` for the browser bundle. Skipped entirely when
 * `NEXT_PUBLIC_SENTRY_DSN` is empty so OSS users / local dev get a no-op
 * SDK with zero network traffic.
 */
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    // Sample tracing modestly — turn up via env if you need it.
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    // Replays only when DSN is present and the user opts in via env.
    replaysSessionSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_REPLAY_SAMPLE_RATE ?? 0),
    replaysOnErrorSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_REPLAY_ON_ERROR_RATE ?? 1),
    integrations: [],
  });
}
