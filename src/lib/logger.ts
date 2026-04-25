import 'server-only';

import pino from 'pino';

import { env } from '@/env';

/**
 * Logger setup.
 *
 * In Next.js we deliberately avoid pino's `transport` option — it spawns a
 * worker thread that dynamically requires `lib/worker.js`, a path webpack
 * can't trace, which crashes dev mode with MODULE_NOT_FOUND.
 *
 * Instead we always emit JSON to stdout. For pretty dev output, pipe the
 * dev server through pino-pretty:
 *
 *     pnpm dev | pnpm exec pino-pretty
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    app: 'kitora',
    env: env.NODE_ENV,
  },
});

export type Logger = typeof logger;
