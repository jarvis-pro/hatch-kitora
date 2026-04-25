import NextAuth from 'next-auth';
import createIntlMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';

import { authConfig } from '@/lib/auth/config';
import { routing } from '@/i18n/routing';

const intlMiddleware = createIntlMiddleware(routing);
const { auth } = NextAuth(authConfig);

const PROTECTED = /^\/(?:[a-z]{2}\/)?(?:dashboard|settings)(?:\/|$)/;

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isLoggedIn = !!req.auth?.user;
  const isProtected = PROTECTED.test(pathname);

  if (isProtected && !isLoggedIn) {
    const loginUrl = new URL('/login', req.nextUrl);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return intlMiddleware(req as unknown as NextRequest);
});

export const config = {
  // Skip Next internals, static assets and the auth/Stripe webhook routes
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
