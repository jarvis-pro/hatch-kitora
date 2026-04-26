import type { NextAuthConfig } from 'next-auth';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';

import { env } from '@/env';

/**
 * Edge-safe Auth.js config.
 *
 * Used by `middleware.ts` (which runs on the Edge runtime). It must NOT import
 * the Prisma adapter or anything Node-specific. The full config — with adapter
 * and Credentials provider — lives in `src/lib/auth/index.ts`.
 */
export const authConfig = {
  pages: {
    signIn: '/login',
    error: '/login',
  },
  providers: [
    ...(env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET
      ? [
          GitHub({
            clientId: env.AUTH_GITHUB_ID,
            clientSecret: env.AUTH_GITHUB_SECRET,
            allowDangerousEmailAccountLinking: true,
          }),
        ]
      : []),
    ...(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET
      ? [
          Google({
            clientId: env.AUTH_GOOGLE_ID,
            clientSecret: env.AUTH_GOOGLE_SECRET,
            allowDangerousEmailAccountLinking: true,
          }),
        ]
      : []),
  ],
  callbacks: {
    authorized({ auth, request }) {
      // NOTE: this callback is bypassed in this codebase — `src/middleware.ts`
      // calls `auth(callback)` with its own logic, which takes precedence
      // over `authorized()`. The redirect / role / tfa_pending decisions
      // therefore live there. We keep this stub for direct `auth()` calls
      // (RSC boundary helpers) where the same rules still apply.
      const isLoggedIn = !!auth?.user;
      const { pathname } = request.nextUrl;
      const isProtected = /^\/[^/]+\/(dashboard|settings|admin)/.test(pathname);
      const isAdminOnly = /^\/[^/]+\/admin/.test(pathname);

      if (isProtected && !isLoggedIn) {
        return false;
      }
      if (isAdminOnly && auth?.user?.role !== 'ADMIN') {
        return false;
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        const role = (user as { role?: 'USER' | 'ADMIN' }).role;
        token.role = role ?? 'USER';
        const sv = (user as { sessionVersion?: number }).sessionVersion;
        token.sessionVersion = typeof sv === 'number' ? sv : 0;
        // RFC 0002 PR-2 — initial sign-in: if the user has 2FA on, mark the
        // token as pending until they pass /login/2fa. The Node-side jwt
        // callback also re-evaluates this on every call so a *just enabled*
        // 2FA setting can't be sidestepped by an existing JWT.
        const tfa = (user as { twoFactorEnabled?: boolean }).twoFactorEnabled;
        if (tfa) {
          token.tfa_pending = true;
        }
      }
      // The full Node-side config in `src/lib/auth/index.ts` overrides this
      // callback to additionally validate `token.sessionVersion` against the
      // database — the edge-safe version here can't query Prisma.
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.id as string) ?? session.user.id;
        session.user.role = (token.role as 'USER' | 'ADMIN' | undefined) ?? 'USER';
      }
      // RFC 0002 PR-1 — propagate sidHash so server actions / RSC can flag
      // the "current" device session in the active-sessions UI. Only the
      // hash leaves the JWT; the raw sid is never exposed.
      const sidHash = (token as { sidHash?: string }).sidHash;
      if (typeof sidHash === 'string' && sidHash.length > 0) {
        session.sidHash = sidHash;
      }
      // RFC 0002 PR-2 — surface tfa_pending so middleware / RSC can route
      // unverified users to /login/2fa.
      if (token.tfa_pending === true) {
        session.tfaPending = true;
      }
      return session;
    },
  },
  session: { strategy: 'jwt' },
  secret: env.AUTH_SECRET,
} satisfies NextAuthConfig;
