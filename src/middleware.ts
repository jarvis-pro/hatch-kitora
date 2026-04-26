import NextAuth from 'next-auth';
import createIntlMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';

import { authConfig } from '@/lib/auth/config';
import { routing } from '@/i18n/routing';

const intlMiddleware = createIntlMiddleware(routing);
const { auth } = NextAuth(authConfig);

const PROTECTED = /^\/(?:[a-z]{2}\/)?(?:dashboard|settings|admin)(?:\/|$)/;
const ADMIN_ONLY = /^\/(?:[a-z]{2}\/)?admin(?:\/|$)/;
// RFC 0002 PR-2 — the only page a tfa-pending user is allowed to reach.
// Anything else under PROTECTED gets bounced to /login/2fa.
const TFA_CHALLENGE = /^\/(?:[a-z]{2}\/)?login\/2fa(?:\/|$)/;
// RFC 0002 PR-4 — pages a PENDING_DELETION user is allowed to reach.
// Settings is the only sanctioned destination so they can cancel; anything
// else under PROTECTED gets funnelled to /settings.
const SETTINGS_BASE = /^\/(?:[a-z]{2}\/)?settings(?:\/|$)/;

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const user = req.auth?.user;
  const isLoggedIn = !!user;
  const isProtected = PROTECTED.test(pathname);
  const isAdminOnly = ADMIN_ONLY.test(pathname);
  const isTfaChallenge = TFA_CHALLENGE.test(pathname);
  const tfaPending = req.auth?.tfaPending === true;

  if (isProtected && !isLoggedIn) {
    const loginUrl = new URL('/login', req.nextUrl);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // RFC 0002 PR-2 — a logged-in user with `tfa_pending` may only see the
  // 2FA challenge page. Everything else under PROTECTED is bounced to
  // /login/2fa with the originally-requested path captured for post-verify
  // redirect. (We let the page itself, not just admin pages, gate this so
  // someone half-authenticated can't poke /settings either.)
  if (isLoggedIn && tfaPending && isProtected && !isTfaChallenge) {
    const url = new URL('/login/2fa', req.nextUrl);
    url.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(url);
  }

  // RFC 0002 PR-4 — accounts in the deletion grace period only have one
  // sanctioned destination: /settings (where the cancel banner lives).
  // We deliberately don't 404 the rest — keeping the user able to sign in
  // and pivot is the whole point of the grace period.
  const userStatus = req.auth?.userStatus;
  const isSettings = SETTINGS_BASE.test(pathname);
  if (isLoggedIn && userStatus === 'PENDING_DELETION' && isProtected && !isSettings) {
    return NextResponse.redirect(new URL('/settings', req.nextUrl));
  }

  if (isAdminOnly && user?.role !== 'ADMIN') {
    return NextResponse.redirect(new URL('/dashboard', req.nextUrl));
  }

  return intlMiddleware(req as unknown as NextRequest);
});

export const config = {
  // Skip Next internals, static assets and the auth/Stripe webhook routes
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
