// RFC 0007 PR-1 — Ephemeral WebAuthn challenge storage.
//
// Each register / authenticate ceremony starts with a server-generated
// 32-byte random challenge. The browser includes it (signed by the
// authenticator) in the response; the server cross-checks. This module
// is the single sanctioned spot to mint + consume challenges.
//
// Storage strategy: instead of a separate `WebAuthnChallenge` table,
// we squat on two columns of `User` (`webauthnChallenge` +
// `webauthnChallengeAt`). Trade-off:
//
//   pro:  one less table, one less migration, one less cleanup cron;
//         each user can only have one ceremony in flight at a time
//         which matches reality (no two browsers signing simultaneously
//         for the same account).
//   con:  if a user starts a ceremony in tab A then opens tab B and
//         starts another, tab A's challenge is overwritten and tab A's
//         ceremony will fail at verify. Deemed acceptable — UX issue
//         only, not a security one.
//
// Lifetime is 5 minutes (TTL_MS). `consumeChallenge` is read-time
// expiry-checked; expired challenges are treated identically to
// "no challenge in progress" (both return `null`).

import 'server-only';

import { randomBytes } from 'node:crypto';

import { prisma } from '@/lib/db';

const TTL_MS = 5 * 60 * 1000;

/**
 * Generate + persist a fresh challenge for `userId`. Overwrites any
 * existing challenge in flight for the same user.
 */
export async function mintChallenge(userId: string): Promise<string> {
  const challenge = randomBytes(32).toString('base64url');
  await prisma.user.update({
    where: { id: userId },
    data: {
      webauthnChallenge: challenge,
      webauthnChallengeAt: new Date(),
    },
  });
  return challenge;
}

/**
 * Read + clear the challenge for `userId`. Returns `null` if there is
 * no challenge in flight, or the challenge is older than `TTL_MS`.
 *
 * Always clears the row's challenge fields, even on a no-op read — this
 * way an attacker can't replay an expired challenge by calling consume
 * twice.
 */
export async function consumeChallenge(userId: string): Promise<string | null> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { webauthnChallenge: true, webauthnChallengeAt: true },
  });
  // Always clear — defensive even when there's nothing to consume.
  if (row?.webauthnChallenge) {
    await prisma.user.update({
      where: { id: userId },
      data: { webauthnChallenge: null, webauthnChallengeAt: null },
    });
  }
  if (!row?.webauthnChallenge || !row.webauthnChallengeAt) return null;
  const ageMs = Date.now() - row.webauthnChallengeAt.getTime();
  if (ageMs > TTL_MS) return null;
  return row.webauthnChallenge;
}

/**
 * For the discoverable / usernameless login flow we don't yet know
 * which user is signing — we mint a challenge keyed by an opaque
 * server-generated session id stashed in the response cookie, not by
 * userId. This stub is here so PR-4 can add a `mintAnonymousChallenge`
 * implementation without touching call sites that already use the
 * userId-keyed path.
 *
 * @internal Only the PR-4 passwordless route reaches here.
 */
export async function __anonymousChallengeStubForPR4(): Promise<never> {
  throw new Error('webauthn-anonymous-challenge-not-yet-implemented (RFC 0007 PR-4)');
}
