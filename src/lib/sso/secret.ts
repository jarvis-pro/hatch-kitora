// NOTE: deliberately *not* `'server-only'` here — server actions, server
// components, and (eventually) the Playwright e2e suite all import this
// module. The transitive `@/env` runtime validation already gates client
// bundling.
//
// Two pieces of secret material live in `IdentityProvider`:
//
//   1. OIDC `client_secret` — AES-256-GCM ciphertext, key HKDF-derived from
//      `AUTH_SECRET + endpoint id`. Same envelope as RFC 0002 / 0003.
//   2. SCIM token — `scim_<base64url(32)>`. We persist `sha256(plaintext)`
//      + the first 8 chars (the "prefix") for UI / log display. Plaintext
//      flows back to the user exactly once at create / rotate.

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

import { env } from '@/env';

// ─── OIDC client secret envelope ────────────────────────────────────────────

const OIDC_KEY_INFO = 'kitora-sso-oidc-v1';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveOidcKey(providerId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', env.AUTH_SECRET, providerId, OIDC_KEY_INFO, KEY_LEN));
}

export function encryptOidcSecret(providerId: string, plaintext: string): Buffer {
  const key = deriveOidcKey(providerId);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decryptOidcSecret(providerId: string, packed: Buffer): string {
  if (packed.length < IV_LEN + TAG_LEN) {
    throw new Error('oidc-secret-too-short');
  }
  const iv = packed.subarray(0, IV_LEN);
  const tag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = packed.subarray(IV_LEN + TAG_LEN);
  const key = deriveOidcKey(providerId);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ─── SCIM token issuance ────────────────────────────────────────────────────

const SCIM_PREFIX = 'scim_';
const SCIM_RAW_BYTES = 32;

export interface FreshScimToken {
  /** Plaintext to hand back to the user once. Format: `scim_<base64url(32)>`. */
  plain: string;
  /** sha256 hex of plaintext — fingerprint stored in DB. */
  hash: string;
  /** First 8 chars of the base64url body — safe to display in UIs / logs. */
  prefix: string;
}

export function generateScimToken(): FreshScimToken {
  const raw = randomBytes(SCIM_RAW_BYTES).toString('base64url');
  const plain = `${SCIM_PREFIX}${raw}`;
  return {
    plain,
    hash: createHash('sha256').update(plain).digest('hex'),
    prefix: raw.slice(0, 8),
  };
}

export function hashScimToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}
