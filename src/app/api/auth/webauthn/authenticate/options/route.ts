// RFC 0007 PR-4 — POST /api/auth/webauthn/authenticate/options (anonymous)
//
// Step 1 of the passwordless ("Sign in with a passkey") flow on /login.
// No session required. Returns the SDK-issued options envelope with
// `allowCredentials: []` so the browser pops a discoverable picker —
// the user picks any of their stored passkeys for this RP ID, and we
// learn the user only at verify time.
//
// The challenge is persisted in an httpOnly cookie (5-min TTL); see
// `src/lib/webauthn/anonymous-challenge.ts` for the rationale.

import { NextResponse } from 'next/server';

import { generateAuthenticationOptions } from '@simplewebauthn/server';

import { logger } from '@/lib/logger';
import { authLimiter } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/request';
import { setAnonymousChallenge } from '@/lib/webauthn/anonymous-challenge';
import { getRpId } from '@/lib/webauthn/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  // Anonymous endpoint — rate-limit by IP. Same budget as the password
  // login form (RFC 0002 PR-1: authLimiter).
  const ip = await getClientIp();
  const { success } = await authLimiter.limit(`webauthn-options:${ip}`);
  if (!success) {
    return NextResponse.json({ error: 'rate-limited' }, { status: 429 });
  }

  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    // Empty allowCredentials → discoverable / usernameless flow. Browser
    // shows the OS / password manager picker; user selects which passkey
    // to use, signature comes back with `userHandle` we can decode.
    allowCredentials: [],
    userVerification: 'preferred',
  });

  await setAnonymousChallenge(options.challenge);

  logger.info({ ip }, 'webauthn-passwordless-options-issued');
  return NextResponse.json(options);
}
