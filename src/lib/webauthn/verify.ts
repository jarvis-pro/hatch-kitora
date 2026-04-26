// RFC 0007 PR-1 — Verify wrappers around `@simplewebauthn/server`.
//
// Two verify operations:
//
//   * verifyRegistration  — called by the `/register/verify` route after
//                            navigator.credentials.create(). Produces a
//                            new credential row's worth of data.
//   * verifyAuthentication — called by `/authenticate/verify` after
//                            navigator.credentials.get(). Re-verifies
//                            against an existing stored credential and
//                            updates its counter / lastUsedAt.
//
// Both wrap the SimpleWebAuthn helpers in the deploy-region-aware
// origin / RP ID config so call sites don't need to import config.ts
// themselves. Errors are normalised to `null`-on-fail so route handlers
// can branch on truthy/falsy without try/catch sprawl.

import 'server-only';

import type * as SimpleWebAuthnServer from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

import { logger } from '@/lib/logger';

import { getOrigin, getRpId } from './config';

// ─── Lazy SDK init ─────────────────────────────────────────────────────────
//
// SimpleWebAuthn ships ESM with `import { ... }` named exports; dynamic
// import keeps the module out of edge bundles + makes upgrade-time
// breakage easier to localise (RFC 0006 PR-3 wrestled with similar SDK
// type drift on alipay-sdk / wechatpay-node-v3).

let _sdk: typeof SimpleWebAuthnServer | null = null;

async function getSdk(): Promise<typeof SimpleWebAuthnServer> {
  if (_sdk) return _sdk;
  _sdk = await import('@simplewebauthn/server');
  return _sdk;
}

// ─── Registration verification ─────────────────────────────────────────────

export interface VerifyRegistrationInput {
  response: RegistrationResponseJSON;
  /** Challenge minted at /register/options time, returned via `consumeChallenge`. */
  expectedChallenge: string;
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  /** Authenticator-reported transports — empty array if none. */
  transports: string[];
  /** 'singleDevice' (device-bound) or 'multiDevice' (synced passkey). */
  deviceType: 'singleDevice' | 'multiDevice';
  /** AuthenticatorData BE flag — true iff the credential is cloud-backed. */
  backedUp: boolean;
}

/**
 * Verify a registration response. Returns null on any failure so the
 * route handler can short-circuit with a 4xx without rethrowing.
 */
export async function verifyRegistration(
  input: VerifyRegistrationInput,
): Promise<VerifiedRegistration | null> {
  const sdk = await getSdk();
  try {
    const result = await sdk.verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: getOrigin(),
      expectedRPID: getRpId(),
      // We don't pin attestation: 'none' is the default and we don't
      // need certified-vendor restrictions for v1 (RFC 0007 §1).
      requireUserVerification: false,
    });

    if (!result.verified || !result.registrationInfo) {
      logger.warn({ result }, 'webauthn-register-verify-failed');
      return null;
    }

    const info = result.registrationInfo;
    return {
      credentialId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    };
  } catch (error) {
    logger.warn({ err: error }, 'webauthn-register-verify-throw');
    return null;
  }
}

// ─── Authentication verification ────────────────────────────────────────────

export interface VerifyAuthenticationInput {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  /** The stored credential row this assertion claims to be from. */
  credential: {
    id: string; // base64url credentialId
    publicKey: Buffer;
    counter: number;
    transports: string[];
  };
}

export interface VerifiedAuthentication {
  /** Authenticator-reported new counter — caller persists it. */
  newCounter: number;
}

/**
 * Verify an authentication response against a stored credential.
 * Returns null on any failure (signature mismatch, replay, expired
 * challenge, origin mismatch).
 */
export async function verifyAuthentication(
  input: VerifyAuthenticationInput,
): Promise<VerifiedAuthentication | null> {
  const sdk = await getSdk();
  try {
    // SimpleWebAuthn v13 declares `publicKey: Uint8Array<ArrayBuffer>`.
    // Node's `Buffer` is technically `Uint8Array<ArrayBufferLike>` (which
    // includes SharedArrayBuffer) — TS rejects the assignment under
    // strict mode. Re-wrap into a plain Uint8Array<ArrayBuffer> by
    // copying the underlying bytes; the .buffer of the new array is
    // guaranteed to be a real ArrayBuffer.
    const publicKey = new Uint8Array(input.credential.publicKey);

    const result = await sdk.verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: getOrigin(),
      expectedRPID: getRpId(),
      credential: {
        id: input.credential.id,
        publicKey,
        counter: input.credential.counter,
        transports: input.credential.transports as never,
      },
      requireUserVerification: false,
    });

    if (!result.verified) {
      logger.warn({ verified: false }, 'webauthn-auth-verify-failed');
      return null;
    }

    return { newCounter: result.authenticationInfo.newCounter };
  } catch (error) {
    logger.warn({ err: error }, 'webauthn-auth-verify-throw');
    return null;
  }
}
