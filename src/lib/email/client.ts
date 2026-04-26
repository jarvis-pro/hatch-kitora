// NOTE: deliberately *not* `'server-only'` here — Playwright e2e tests and
// tsx CLI scripts transitively import this via `runWebhookCronTick` and
// other server flows. The transitive `resend` SDK + `@/env` imports are
// Node-only, so accidental client bundling still fails loudly.
import { Resend } from 'resend';

import { env } from '@/env';

let cached: Resend | null = null;

export function getResend(): Resend {
  if (!env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set. Configure it in your environment.');
  }
  cached ??= new Resend(env.RESEND_API_KEY);
  return cached;
}
