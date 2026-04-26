import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

/**
 * RFC 0003 PR-1 — webhook secret helpers.
 *
 * Format: `whsec_<base64url(32 bytes)>`. The `whsec_` prefix matches what
 * Stripe / GitHub use, lowering the cognitive load for integrators who've
 * seen these before. We hand the user the plaintext exactly once at
 * create / rotate time; the DB only ever stores `sha256(plaintext)` and a
 * short prefix for UI disambiguation.
 */

const PREFIX = 'whsec_';
const RAW_BYTES = 32;

export function generateWebhookSecret(): { plain: string; hash: string; prefix: string } {
  const raw = randomBytes(RAW_BYTES).toString('base64url');
  const plain = `${PREFIX}${raw}`;
  return {
    plain,
    hash: createHash('sha256').update(plain).digest('hex'),
    // First 8 chars after the `whsec_` prefix — collision-safe for UI use
    // because we have ~10^14 endpoints' worth of headroom.
    prefix: raw.slice(0, 8),
  };
}

export function hashWebhookSecret(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}
