// NOTE: deliberately *not* `'server-only'` here — the SSO callback route
// imports this. Transitive `next-auth/jwt` + `@/lib/db` are Node-only.
//
// Direct Auth.js v5 session minting for the SSO path. Bypasses the normal
// Credentials `authorize()` flow — we already verified the user via
// Jackson's SAML response, so the JWT goes out of band:
//
//   1. Mint a fresh `sid` (RFC 0002 PR-1) + persist a `DeviceSession` row.
//   2. Encode an Auth.js JWT mirroring the shape `jwt()` callback would
//      produce — `id`, `role`, `sessionVersion`, `status`, `tfa_pending`,
//      `sid`, `sidHash`.
//   3. Stamp the session cookie name Auth.js expects, name + flags
//      auto-derived from `AUTH_URL` protocol per Auth.js v5 conventions.

import { encode } from 'next-auth/jwt';
import type { NextResponse } from 'next/server';

import { env } from '@/env';
import { createDeviceSession, generateSid, hashSid } from '@/lib/auth/device-session';
import { prisma } from '@/lib/db';

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days — same as Auth.js default

interface IssueInput {
  userId: string;
  /** Optional UA / IP captured from the originating request, for the DeviceSession row. */
  userAgent?: string | null;
  ip?: string | null;
}

interface IssuedCookie {
  name: string;
  value: string;
  /** Match Auth.js's own cookie flags so middleware decoders treat it identically. */
  options: {
    httpOnly: true;
    sameSite: 'lax';
    secure: boolean;
    path: '/';
    maxAge: number;
  };
}

/**
 * Mint a fresh Auth.js session for `userId` and return the cookie shape so
 * the caller can attach it to a `NextResponse.redirect(...)`.
 *
 * Returns null if `userId` no longer resolves (race vs hard-delete) — caller
 * should redirect back to /login with `sso_error=user-gone` in that case.
 */
export async function issueSsoSession(input: IssueInput): Promise<IssuedCookie | null> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      id: true,
      role: true,
      sessionVersion: true,
      status: true,
    },
  });
  if (!user) return null;

  const rawSid = generateSid();
  await createDeviceSession({
    userId: user.id,
    rawSid,
    userAgent: input.userAgent ?? null,
    ip: input.ip ?? null,
  });

  // The cookie name Auth.js v5 reads is environment-dependent. Production
  // (HTTPS) uses the `__Secure-` prefix; HTTP dev / e2e uses the plain name.
  const secure = (env.AUTH_URL ?? env.NEXT_PUBLIC_APP_URL).startsWith('https://');
  const cookieName = secure ? '__Secure-authjs.session-token' : 'authjs.session-token';

  // Token shape mirrors what `src/lib/auth/index.ts`'s `jwt()` callback
  // emits at sign-in. Keep field names in lockstep with that callback +
  // `src/lib/auth/config.ts`'s `session()` callback so the rest of the
  // stack reads SSO sessions exactly as it reads Credentials sessions.
  const value = await encode({
    token: {
      sub: user.id,
      id: user.id,
      role: user.role,
      sessionVersion: user.sessionVersion,
      status: user.status,
      // SSO bypasses the local 2FA challenge — IdP has its own MFA.
      tfa_pending: false,
      sid: rawSid,
      sidHash: hashSid(rawSid),
    },
    secret: env.AUTH_SECRET,
    salt: cookieName,
    maxAge: SESSION_MAX_AGE,
  });

  return {
    name: cookieName,
    value,
    options: {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: SESSION_MAX_AGE,
    },
  };
}

/** Convenience: attach an issued cookie to a `NextResponse`. */
export function attachSsoSessionCookie(res: NextResponse, cookie: IssuedCookie): void {
  res.cookies.set(cookie.name, cookie.value, cookie.options);
}
