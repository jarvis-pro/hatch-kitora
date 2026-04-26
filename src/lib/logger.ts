// NOTE: deliberately *not* `'server-only'` here — Playwright e2e tests and
// tsx-driven cron scripts both need to import server-side modules that
// transitively pull in `logger`. The transitive `@/env` import already
// validates Node-only env vars at boot, so accidental client bundling
// still fails loudly. Pino itself has a browser build that's benign.
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
