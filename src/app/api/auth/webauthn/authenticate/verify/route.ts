// RFC 0007 PR-4 — POST /api/auth/webauthn/authenticate/verify (anonymous)
//
// Step 2 of the passwordless flow on /login. Receives the verbatim
// `AuthenticationResponseJSON` from `startAuthentication()`, looks up
// the credential in our DB by its protocol-level `id`, verifies the
// signature, and mints a fresh Auth.js session via `issueSsoSession`
// (same JWT-direct-encode shape RFC 0004 SSO uses).
//
// On success the response sets the session cookie + responds with a
// `redirectTo` field; the client navigates the browser. We deliberately
// don't 302 — the SDK fetch is XHR-style, a redirect would just be
// silently followed by the fetch.
//
// Rate-limit by IP (authLimiter). Failure modes (missing challenge,
// unknown credential, bad signature) all return 401 with a generic
// error code so an attacker can't map credentialId space.

import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { attachSsoSessionCookie, issueSsoSession } from '@/lib/sso/issue-session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { authLimiter } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/request';
import { consumeAnonymousChallenge } from '@/lib/webauthn/anonymous-challenge';
import { verifyAuthentication } from '@/lib/webauthn/verify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const inputSchema = z.object({
  /** Verbatim AuthenticationResponseJSON from `startAuthentication()`. */
  response: z.unknown(),
  /** Optional callback URL — passed through to the redirect. */
  callbackUrl: z.string().optional(),
});

export async function POST(request: Request) {
  const ip = await getClientIp();
  const { success } = await authLimiter.limit(`webauthn-verify:${ip}`);
  if (!success) {
    return NextResponse.json({ error: 'rate-limited' }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid-input' }, { status: 400 });
  }

  const challenge = await consumeAnonymousChallenge();
  if (!challenge) {
    return NextResponse.json({ error: 'challenge-expired' }, { status: 400 });
  }

  const response = parsed.data.response as AuthenticationResponseJSON;
  if (typeof response?.id !== 'string') {
    return NextResponse.json({ error: 'invalid-input' }, { status: 400 });
  }

  // Reverse-lookup: the credentialId is what we stored at register
  // time. PENDING_DELETION users can still sign in via password (RFC
  // 0002 PR-4 — to cancel the deletion); allow Passkey on the same
  // basis. No further status gate needed at v1.
  const credential = await prisma.webAuthnCredential.findUnique({
    where: { credentialId: response.id },
    select: {
      id: true,
      userId: true,
      credentialId: true,
      publicKey: true,
      counter: true,
      transports: true,
    },
  });
  if (!credential) {
    logger.warn({ ip }, 'webauthn-passwordless-credential-not-found');
    return NextResponse.json({ error: 'verification-failed' }, { status: 401 });
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
    logger.warn(
      { ip, userId: credential.userId, credId: credential.id },
      'webauthn-passwordless-verify-failed',
    );
    return NextResponse.json({ error: 'verification-failed' }, { status: 401 });
  }

  // Bump credential state.
  await prisma.webAuthnCredential.update({
    where: { id: credential.id },
    data: { counter: verified.newCounter, lastUsedAt: new Date() },
  });

  // Mint fresh JWT + DeviceSession row + cookie. Same pattern RFC 0004
  // uses for SSO bypass — the resulting session shape (sub / id / role
  // / sessionVersion / status / tfa_pending: false / sid / sidHash) is
  // indistinguishable from a password+TOTP session, so middleware /
  // RSC don't need to differentiate.
  const headersList = await headers();
  const userAgent = headersList.get('user-agent') ?? null;
  const cookie = await issueSsoSession({
    userId: credential.userId,
    userAgent,
    ip,
  });
  if (!cookie) {
    return NextResponse.json({ error: 'verification-failed' }, { status: 401 });
  }

  await recordAudit({
    actorId: credential.userId,
    action: 'webauthn.login_succeeded',
    target: credential.userId,
    metadata: { credentialDbId: credential.id },
  });

  const callback = parsed.data.callbackUrl?.startsWith('/')
    ? parsed.data.callbackUrl
    : '/dashboard';

  const res = NextResponse.json({ ok: true, redirectTo: callback });
  attachSsoSessionCookie(res, cookie);
  return res;
}
