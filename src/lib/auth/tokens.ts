import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

/**
 * Token utilities for self-managed flows (email verification, password reset).
 *
 * Convention:
 *   - The raw token (URL-safe random string) is delivered to the user via email.
 *   - Only `sha256(token)` is persisted in the database.
 *   - Tokens are single-use: rows are deleted (or marked consumed) on success.
 */

const RAW_TOKEN_BYTES = 32;

/** Generate a URL-safe opaque token (~43 chars, 256 bits of entropy). */
export function generateRawToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString('base64url');
}

/** Stable hash used as the DB lookup key. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Default lifetimes — tweak per flow if needed. */
export const TOKEN_TTL = {
  emailVerification: 1000 * 60 * 60 * 24, // 24h
  passwordReset: 1000 * 60 * 30, // 30min
} as const;

export function expiresAt(ttlMs: number): Date {
  return new Date(Date.now() + ttlMs);
}
