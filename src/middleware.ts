import NextAuth from 'next-auth';
import createIntlMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';

import { authConfig } from '@/lib/auth/config';
import { routing } from '@/i18n/routing';

const intlMiddleware = createIntlMiddleware(routing);
const { auth } = NextAuth(authConfig);

const PROTECTED = /^\/(?:[a-z]{2}\/)?(?:dashboard|settings|admin)(?:\/|$)/;
const ADMIN_ONLY = /^\/(?:[a-z]{2}\/)?admin(?:\/|$)/;

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const user = req.auth?.user;
  const isLoggedIn = !!user;
  const isProtected = PROTECTED.test(pathname);
  const isAdminOnly = ADMIN_ONLY.test(pathname);

  if (isProtected && !isLoggedIn) {
    const loginUrl = new URL('/login', req.nextUrl);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
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
