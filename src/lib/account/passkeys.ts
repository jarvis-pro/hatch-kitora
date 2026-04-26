// RFC 0007 PR-3 — Server actions for the /login/2fa Passkey challenge.
//
// Symmetric with `verifyTfaForCurrentSessionAction` (TOTP path) in
// `src/lib/account/two-factor.ts`: the user is already authenticated
// against their password but `tfa_pending = true`; passing a Passkey
// challenge clears the flag the same way a correct TOTP code does.
//
// Two actions:
//
//   * getPasskeyChallengeAction() — generates `PublicKeyCredentialRequestOptions`
//     for the current user (allowCredentials = their stored credentials)
//     and persists the challenge.
//   * verifyPasskeyForCurrentSessionAction(response) — verifies the
//     assertion against a stored credential, bumps counter / lastUsedAt,
//     calls updateAuthSession({ tfa: 'verified' }) to flip the JWT, and
//     records an audit row.

'use server';

import { generateAuthenticationOptions } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { update as updateAuthSession } from '@/lib/auth';
import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { consumeChallenge } from '@/lib/webauthn/challenge';
import { getRpId } from '@/lib/webauthn/config';
import { verifyAuthentication } from '@/lib/webauthn/verify';

const verifySchema = z.object({
  /** Verbatim AuthenticationResponseJSON from `startAuthentication()`. */
  response: z.unknown(),
});

/**
 * Step 1 of the 2FA-challenge passkey ceremony.
 *
 * Returns the SDK-issued options envelope. Side effects:
 *   * Persists `options.challenge` on `User.webauthnChallenge` for verify
 *     to cross-check.
 *   * `allowCredentials` filtered to the user's existing credentials so
 *     the browser only prompts for one of those (not arbitrary discoverable
 *     keys — that's the PR-4 passwordless path).
 */
export async function getPasskeyChallengeAction() {
  const me = await requireUser().catch(() => null);
  if (!me) {
    return { ok: false as const, error: 'unauthorized' as const };
  }

  const credentials = await prisma.webAuthnCredential.findMany({
    where: { userId: me.id },
    select: { credentialId: true, transports: true },
  });
  if (credentials.length === 0) {
    return { ok: false as const, error: 'no-passkeys' as const };
  }

  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    allowCredentials: credentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports as never,
    })),
    userVerification: 'preferred',
  });

  await prisma.user.update({
    where: { id: me.id },
    data: {
      webauthnChallenge: options.challenge,
      webauthnChallengeAt: new Date(),
    },
  });

  return { ok: true as const, options };
}

/**
 * Step 2 of the 2FA-challenge passkey ceremony.
 *
 * Verifies the SDK assertion against a stored credential, then flips the
 * JWT's `tfa_pending` to false via `updateAuthSession({ tfa: 'verified' })`.
 * Symmetric with the TOTP path (RFC 0002 PR-2 §verifyTfaForCurrentSessionAction).
 */
export async function verifyPasskeyForCurrentSessionAction(input: z.infer<typeof verifySchema>) {
  const me = await requireUser().catch(() => null);
  if (!me) {
    return { ok: false as const, error: 'unauthorized' as const };
  }
  const parsed = verifySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const challenge = await consumeChallenge(me.id);
  if (!challenge) {
    return { ok: false as const, error: 'challenge-expired' as const };
  }

  // The assertion's `id` field is the credentialId — look it up.
  const response = parsed.data.response as AuthenticationResponseJSON;
  if (typeof response?.id !== 'string') {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const credential = await prisma.webAuthnCredential.findFirst({
    where: { credentialId: response.id, userId: me.id },
    select: {
      id: true,
      credentialId: true,
      publicKey: true,
      counter: true,
      transports: true,
    },
  });
  if (!credential) {
    logger.warn({ userId: me.id }, 'webauthn-tfa-credential-not-found');
    return { ok: false as const, error: 'unknown-credential' as const };
  }

  const verified = await verifyAuthentication({
    response,
    expectedChallenge: challenge,
    credential: {
      id: credential.credentialId,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports,
    },
  });
  if (!verified) {
    logger.warn({ userId: me.id, credId: credential.id }, 'webauthn-tfa-verify-failed');
    return { ok: false as const, error: 'verification-failed' as const };
  }

  await prisma.webAuthnCredential.update({
    where: { id: credential.id },
    data: { counter: verified.newCounter, lastUsedAt: new Date() },
  });

  // Mirror TOTP success path: flip the JWT's tfa_pending flag.
  await updateAuthSession({ tfa: 'verified' } as unknown as Parameters<
    typeof updateAuthSession
  >[0]).catch(() => {});

  await recordAudit({
    actorId: me.id,
    action: 'webauthn.tfa_succeeded',
    target: me.id,
    metadata: { credentialDbId: credential.id },
  });

  return { ok: true as const };
}
