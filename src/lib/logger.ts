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
// `env.LOG_LEVEL` normally goes through zod's `.default('info')`, but when
// SKIP_ENV_VALIDATION=1 (CI / build) zod is bypassed and the value can be
// undefined. Pino throws on an undefined level, so we hard-fall-back here.
const level = env.LOG_LEVEL ?? 'info';

export const logger = pino({
  level,
  base: {
    app: 'kitora',
    env: env.NODE_ENV ?? 'production',
  },
});

export type Logger = typeof logger;
