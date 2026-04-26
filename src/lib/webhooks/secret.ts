// NOTE: deliberately *not* `'server-only'` here — the Playwright e2e suite
// round-trips `encryptSecret` / `decryptSecret` against a real endpoint id
// to guard against a recurring "ciphertext is lossy" regression. The
// transitive `@/env` import is itself server-gated (validates at boot
// against `process.env`), so accidental client bundling still fails loudly
// even without the explicit marker.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

import { env } from '@/env';

/**
 * RFC 0003 PR-1 / PR-2 — webhook secret helpers.
 *
 * Format: `whsec_<base64url(32 bytes)>` — same naming as Stripe / GitHub
 * so integrators recognise the shape at a glance.
 *
 * Two pieces of bookkeeping per secret:
 *
 *   1. `secretHash` — sha256 of plaintext. Used as a fingerprint and a
 *      legacy lookup (PR-1 wrote rows with only this field).
 *   2. `encSecret`  — AES-256-GCM ciphertext of plaintext, key derived
 *      from AUTH_SECRET + endpoint id via HKDF. The cron decrypts this
 *      to compute outgoing HMACs (PR-2 added it).
 *
 * `secretPrefix` is the first 8 chars of the base64url body (after the
 * `whsec_` prefix) — safe to display in the UI.
 */

const PREFIX = 'whsec_';
const RAW_BYTES = 32;
const KEY_INFO = 'kitora-webhook-v1';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

export interface FreshSecret {
  /** The plaintext to hand back to the user (one-time). */
  plain: string;
  /** sha256 hex of plaintext — fingerprint / backwards-compat. */
  hash: string;
  /** First 8 chars of the base64url body — safe to display. */
  prefix: string;
  /**
   * Encryption helper closure — call with the freshly-created endpoint id
   * to produce the ciphertext we persist. We split into two steps because
   * the id is only known after the row insert.
   */
  encryptForEndpoint: (endpointId: string) => Buffer;
}

export function generateWebhookSecret(): FreshSecret {
  const raw = randomBytes(RAW_BYTES).toString('base64url');
  const plain = `${PREFIX}${raw}`;
  return {
    plain,
    hash: createHash('sha256').update(plain).digest('hex'),
    prefix: raw.slice(0, 8),
    encryptForEndpoint: (endpointId) => encryptSecret(endpointId, plain),
  };
}

export function hashWebhookSecret(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

// ─── HKDF-derived per-endpoint key ──────────────────────────────────────────

function deriveKey(endpointId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', env.AUTH_SECRET, endpointId, KEY_INFO, KEY_LEN));
}

export function encryptSecret(endpointId: string, plaintext: string): Buffer {
  const key = deriveKey(endpointId);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decryptSecret(endpointId: string, packed: Buffer): string {
  if (packed.length < IV_LEN + TAG_LEN) {
    throw new Error('webhook-secret-too-short');
  }
  const iv = packed.subarray(0, IV_LEN);
  const tag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = packed.subarray(IV_LEN + TAG_LEN);
  const key = deriveKey(endpointId);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
