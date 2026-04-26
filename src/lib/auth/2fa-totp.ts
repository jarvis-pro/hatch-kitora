import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 0002 PR-2 — pure TOTP / base32 helpers.
 *
 * Split out of `2fa-crypto.ts` because the encryption parts of that module
 * depend on `env.AUTH_SECRET` (server-only), but tests need to compute
 * codes against a known secret without yanking in the whole module graph.
 * Nothing in here touches the DB or env vars.
 */

// ─── Base32 (RFC 4648) ──────────────────────────────────────────────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid-base32-char');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ─── TOTP (RFC 6238 / RFC 4226) ─────────────────────────────────────────────

const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30; // seconds

/** Generate a fresh 20-byte TOTP secret. */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

/** Compute the TOTP code for a given counter (used for verify and tests). */
function hotp(secret: Buffer, counter: bigint): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter);
  const mac = createHmac('sha1', secret).update(counterBuf).digest();
  // SHA-1 digest is always 20 bytes — these accesses are in-bounds; assert
  // to satisfy noUncheckedIndexedAccess.
  const offset = mac[mac.length - 1]! & 0x0f;
  const truncated =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  const code = truncated % 10 ** TOTP_DIGITS;
  return code.toString().padStart(TOTP_DIGITS, '0');
}

/** Compute the current TOTP for a secret. Useful for tests / dev tooling. */
export function totpNow(secret: Buffer, now = Date.now()): string {
  const counter = BigInt(Math.floor(now / 1000 / TOTP_PERIOD));
  return hotp(secret, counter);
}

/**
 * Verify a 6-digit TOTP code with a ±1-step window. Returns true on match.
 * Constant-time string compare per step to avoid leaking which step matched.
 */
export function verifyTotp(secret: Buffer, code: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = BigInt(Math.floor(now / 1000 / TOTP_PERIOD));
  for (const offset of [0n, -1n, 1n]) {
    const expected = hotp(secret, counter + offset);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(code, 'utf8');
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return true;
    }
  }
  return false;
}

/**
 * Build the otpauth:// URI users paste / scan into their authenticator.
 * Per Google Authenticator's spec; the issuer ends up labeled in the app.
 */
export function buildOtpauthUri(opts: {
  secret: Buffer;
  accountLabel: string; // typically the user's email
  issuer: string; // app name, e.g. "Kitora"
}): string {
  const secret = base32Encode(opts.secret);
  const label = encodeURIComponent(`${opts.issuer}:${opts.accountLabel}`);
  const params = new URLSearchParams({
    secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
