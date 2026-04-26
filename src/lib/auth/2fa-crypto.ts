import 'server-only';

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { env } from '@/env';

/**
 * RFC 0002 PR-2 — server-only crypto for 2FA.
 *
 * Two responsibilities:
 *
 *   1. AES-256-GCM encryption of the shared TOTP secret. The key is derived
 *      via HKDF from `AUTH_SECRET` + `userId` (the row-id is the salt) so a
 *      single-row leak doesn't compromise the rest of the table. Format:
 *      `[12-byte IV][16-byte auth tag][ciphertext]` packed into one Buffer.
 *
 *   2. Backup code generation + verification. 10 codes per user, sha256-
 *      hashed in the DB; we delete on use rather than flag, so an attacker
 *      reading the row can't infer how many remain.
 *
 * Pure TOTP / base32 helpers live in `./2fa-totp.ts` so that test code can
 * import them without pulling in `server-only` (which throws when imported
 * outside an RSC context).
 */

// Re-export the pure helpers so callers don't need to know the split.
export {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  totpNow,
  verifyTotp,
} from './2fa-totp';

// ─── HKDF-derived per-user key ──────────────────────────────────────────────

const KEY_INFO = 'kitora-2fa-v1';
const KEY_LEN = 32;

function deriveKey(userId: string): Buffer {
  // Node's hkdfSync returns ArrayBuffer.
  return Buffer.from(hkdfSync('sha256', env.AUTH_SECRET, userId, KEY_INFO, KEY_LEN));
}

// ─── AES-256-GCM encrypt / decrypt ──────────────────────────────────────────

const IV_LEN = 12;
const TAG_LEN = 16;

export function encryptSecret(userId: string, plaintext: Buffer): Buffer {
  const key = deriveKey(userId);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decryptSecret(userId: string, packed: Buffer): Buffer {
  if (packed.length < IV_LEN + TAG_LEN) {
    throw new Error('encrypted-secret-too-short');
  }
  const iv = packed.subarray(0, IV_LEN);
  const tag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = packed.subarray(IV_LEN + TAG_LEN);
  const key = deriveKey(userId);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ─── Backup codes ───────────────────────────────────────────────────────────
//
// 10 single-use codes per user. We display them once at enable / regenerate
// time, the DB only stores sha256(code). On verify, we look up the row, find
// a matching hash, and **delete it from the array** (single-use).

const BACKUP_CODE_COUNT = 10;
const BACKUP_GROUP_LEN = 4;
const BACKUP_GROUPS = 2;
// Crockford-style alphabet — drop ambiguous 0/O/1/I.
const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateOneBackupCode(): string {
  const bytes = randomBytes(BACKUP_GROUP_LEN * BACKUP_GROUPS);
  let chars = '';
  for (let i = 0; i < bytes.length; i++) {
    // randomBytes always returns a buffer of the requested length, so the
    // index is in bounds — assert to satisfy noUncheckedIndexedAccess.
    chars += BACKUP_ALPHABET[bytes[i]! % BACKUP_ALPHABET.length];
  }
  // "XXXX-XXXX" — easy to copy from a printed sheet.
  const groups: string[] = [];
  for (let g = 0; g < BACKUP_GROUPS; g++) {
    groups.push(chars.slice(g * BACKUP_GROUP_LEN, (g + 1) * BACKUP_GROUP_LEN));
  }
  return groups.join('-');
}

export function generateBackupCodes(): { plain: string[]; hashes: string[] } {
  const plain: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const code = generateOneBackupCode();
    plain.push(code);
    hashes.push(hashBackupCode(code));
  }
  return { plain, hashes };
}

export function hashBackupCode(code: string): string {
  // Normalize so users typing "abcd-efgh" or "ABCDEFGH" both work.
  const normalized = code.replace(/-/g, '').toUpperCase();
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Look up a backup code in the user's hash array — returns the matching hash
 * (so the caller can delete it from the array) or null.
 */
export function findBackupCodeHash(userInput: string, hashes: readonly string[]): string | null {
  if (!/^[A-Z0-9-]{4,32}$/i.test(userInput)) return null;
  const candidate = hashBackupCode(userInput);
  for (const h of hashes) {
    // Constant-time compare per element.
    if (h.length === candidate.length) {
      const a = Buffer.from(h, 'hex');
      const b = Buffer.from(candidate, 'hex');
      if (a.length === b.length && timingSafeEqual(a, b)) {
        return h;
      }
    }
  }
  return null;
}
