import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * RFC 0003 PR-2 — webhook payload signing (HMAC-SHA256 over `<ts>.<body>`).
 *
 * Compatible with Stripe / GitHub-style "schemed signature" header. Lives
 * in a no-`server-only` module so the e2e suite (and integrators reading
 * the docs) can lift the verify function verbatim.
 *
 * Outbound header shape:
 *   X-Kitora-Signature: t=1745723404,v1=<hex sha256>
 *
 * Verify steps the receiver must do:
 *   1. Parse `t` and `v1` from the header.
 *   2. Reject if `abs(now - t) > MAX_AGE_SECONDS` (replay window).
 *   3. Recompute `HMAC_SHA256(secret, t + "." + rawBody)` and constant-time
 *      compare with the `v1` value.
 */

const MAX_AGE_SECONDS = 300; // 5 minutes — RFC 0003 §2.3

interface SignOpts {
  secret: string;
  /** Raw (already-stringified) body. Caller must pass the *exact* bytes the receiver will see. */
  body: string;
  /** Optional injection for tests; defaults to current epoch seconds. */
  timestamp?: number;
}

export interface SignedHeaders {
  /** The `X-Kitora-Signature` value (e.g. `t=...,v1=...`). */
  signature: string;
  /** Epoch seconds — already encoded into `signature`, but exposed for separate `X-Kitora-Timestamp` header. */
  timestamp: number;
}

export function signWebhookPayload(opts: SignOpts): SignedHeaders {
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${opts.body}`;
  const v1 = createHmac('sha256', opts.secret).update(signedPayload).digest('hex');
  return {
    signature: `t=${ts},v1=${v1}`,
    timestamp: ts,
  };
}

interface VerifyOpts {
  secret: string;
  /** Raw bytes the receiver got — must NOT be re-stringified. */
  body: string;
  /** Header value to verify, e.g. `t=...,v1=...`. */
  header: string;
  /** Override max replay window (seconds). Default 300. */
  maxAgeSeconds?: number;
  /** Override "now" for tests. Defaults to current epoch seconds. */
  now?: number;
}

export type VerifyVerdict =
  | { ok: true }
  | { ok: false; reason: 'malformed-header' | 'expired' | 'bad-signature' };

/**
 * Pure-function verifier integrators can drop straight into their handlers.
 * Mirrored verbatim in the docs site so the snippet stays in sync.
 */
export function verifyWebhookSignature(opts: VerifyOpts): VerifyVerdict {
  const parts = opts.header.split(',').map((p) => p.trim());
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (k === 't') t = Number.parseInt(v, 10);
    else if (k === 'v1') v1 = v;
  }
  if (t === null || Number.isNaN(t) || !v1) {
    return { ok: false, reason: 'malformed-header' };
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const window = opts.maxAgeSeconds ?? MAX_AGE_SECONDS;
  if (Math.abs(now - t) > window) {
    return { ok: false, reason: 'expired' };
  }

  const expected = createHmac('sha256', opts.secret).update(`${t}.${opts.body}`).digest('hex');
  // Constant-time compare per Buffer; lengths must match before timingSafeEqual,
  // hence the explicit length check.
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad-signature' };
  }
  return { ok: true };
}
