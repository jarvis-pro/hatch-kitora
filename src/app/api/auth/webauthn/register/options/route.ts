// RFC 0007 PR-2 — POST /api/auth/webauthn/register/options
//
// Step 1 of credential registration. Authenticated user; returns the
// `PublicKeyCredentialCreationOptions` envelope the browser feeds to
// `navigator.credentials.create()`. Side effect: persists the SDK-
// generated challenge on `User.webauthnChallenge` for `register/verify`
// to cross-check.
//
// `excludeCredentials` lists the user's existing credentials so the
// browser can dedupe — no point letting Touch ID enroll the same key
// twice.

import { NextResponse } from 'next/server';

import { generateRegistrationOptions } from '@simplewebauthn/server';

import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getRpId, getRpName } from '@/lib/webauthn/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const me = await requireUser().catch(() => null);
  if (!me) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  // Auth.js session shape leaves email / name as `string | null | undefined`.
  // Every Credentials / OAuth / SSO user has an email by construction (the
  // adapter creates it that way), but the type system can't see that —
  // narrow here so the SDK call below sees plain strings.
  if (!me.email) {
    return NextResponse.json({ error: 'no-email-on-account' }, { status: 400 });
  }
  const userEmail = me.email;
  const userDisplayName = me.name ?? me.email;

  const existing = await prisma.webAuthnCredential.findMany({
    where: { userId: me.id },
    select: { credentialId: true, transports: true },
  });

  const options = await generateRegistrationOptions({
    rpName: getRpName(),
    rpID: getRpId(),
    // userID is the WebAuthn-protocol-level user handle — bytes the
    // authenticator stores opaquely. Use our cuid bytes; @simplewebauthn
    // accepts a Uint8Array.
    userID: new TextEncoder().encode(me.id),
    userName: userEmail,
    userDisplayName,
    attestationType: 'none', // RFC 0007 §1 non-goal: attestation chain
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports as never,
    })),
    authenticatorSelection: {
      // 'preferred' — accept hardware keys without UV, but ask for it
      // when the authenticator supports UV (RFC 0007 §9 decision).
      userVerification: 'preferred',
      // Allow both platform (Touch ID / Windows Hello) and cross-platform
      // (YubiKey) authenticators.
      residentKey: 'preferred',
      requireResidentKey: false,
    },
  });

  // Persist the SDK-issued challenge for verify to cross-check.
  // `consumeChallenge` (RFC 0007 PR-1 lib) will read + clear it on
  // verify success or expiry.
  await prisma.user.update({
    where: { id: me.id },
    data: {
      webauthnChallenge: options.challenge,
      webauthnChallengeAt: new Date(),
    },
  });

  logger.info({ userId: me.id }, 'webauthn-register-options-issued');
  return NextResponse.json(options);
}
