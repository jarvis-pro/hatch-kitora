// RFC 0007 PR-1 — WebAuthn Relying Party config.
//
// Three values to nail down before any ceremony can happen:
//
//   * RP ID  — the eTLD+1 the credential is bound to. Must match the
//              page hostname; mismatched origin → browser refuses to
//              sign. In production we set `WEBAUTHN_RP_ID` per region
//              (kitora.io / kitora.cn / kitora.eu); in dev / e2e we
//              fall back to the hostname of `NEXT_PUBLIC_APP_URL`
//              (typically `localhost`).
//
//   * RP Name — human-readable label the OS / browser shows in the
//               consent prompt ("Sign in to Kitora"). Defaults to
//               `Kitora`; overridable via `WEBAUTHN_RP_NAME`.
//
//   * Origin  — full origin (scheme + host + port) the SimpleWebAuthn
//               verify helpers cross-check. We derive it from
//               `NEXT_PUBLIC_APP_URL` directly; setting an explicit
//               `WEBAUTHN_ORIGIN` is rarely needed but supported for
//               weird reverse-proxy setups.

import 'server-only';

import { env } from '@/env';

/**
 * The `id` the WebAuthn protocol binds the credential to. Must equal
 * the document hostname (or a registrable suffix of it). We don't
 * normalise — if someone sets `WEBAUTHN_RP_ID=https://...` that's a
 * config bug we'd rather surface loudly at first ceremony.
 */
export function getRpId(): string {
  if (env.WEBAUTHN_RP_ID) return env.WEBAUTHN_RP_ID;
  // Fallback: pull hostname from NEXT_PUBLIC_APP_URL. URL parser strips
  // scheme + port, leaving the bare host (`kitora.io` or `localhost`).
  return new URL(env.NEXT_PUBLIC_APP_URL).hostname;
}

/** Human-readable RP name shown in the OS / browser consent prompt. */
export function getRpName(): string {
  return env.WEBAUTHN_RP_NAME ?? 'Kitora';
}

/**
 * Expected origin for SimpleWebAuthn verify helpers. Includes scheme +
 * port; SimpleWebAuthn cross-checks it against the client-side
 * `clientDataJSON.origin` field.
 */
export function getOrigin(): string {
  if (env.WEBAUTHN_ORIGIN) return env.WEBAUTHN_ORIGIN;
  return env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
}
