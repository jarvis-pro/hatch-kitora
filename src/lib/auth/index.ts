import { PrismaAdapter } from '@auth/prisma-adapter';
import bcrypt from 'bcryptjs';
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { headers } from 'next/headers';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

import { authConfig } from './config';
import { createDeviceSession, generateSid, hashSid, validateDeviceSession } from './device-session';

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const {
  handlers,
  auth,
  signIn,
  signOut,
  unstable_update: update,
} = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  // Route Auth.js noise through pino with sane levels. Wrong password is
  // user-error, not app-error — keep it at debug so prod logs don't blow up
  // on every failed login.
  logger: {
    error(error) {
      const name = (error as { name?: string }).name ?? error.constructor.name;
      if (name === 'CredentialsSignin') {
        logger.debug({ err: error }, 'auth-credentials-rejected');
        return;
      }
      logger.error({ err: error }, 'auth-error');
    },
    warn(code) {
      logger.warn({ code }, 'auth-warning');
    },
    debug(message, metadata) {
      logger.debug({ metadata }, message);
    },
  },
  providers: [
    ...authConfig.providers,
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const parsed = credentialsSchema.safeParse(credentials);
        if (!parsed.success) {
          return null;
        }

        const { email, password } = parsed.data;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user?.passwordHash) {
          return null;
        }

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
          logger.warn({ email }, 'invalid-credentials');
          return null;
        }

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          role: user.role,
          sessionVersion: user.sessionVersion,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user, trigger, session, account, profile, isNewUser }) {
      // Initial sign-in: delegate to the edge-safe callback so we keep one
      // source of truth for the basic claims.
      const base = await authConfig.callbacks.jwt({
        token,
        user,
        trigger,
        session,
        account,
        profile,
        isNewUser,
      });
      if (!base) return base;

      // ── Initial sign-in: mint a fresh sid + DeviceSession row ─────────
      if (user && base.id) {
        const rawSid = generateSid();
        try {
          const h = await headers();
          await createDeviceSession({
            userId: base.id as string,
            rawSid,
            userAgent: h.get('user-agent'),
            ip:
              h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
              h.get('x-real-ip') ??
              h.get('cf-connecting-ip') ??
              null,
          });
          base.sid = rawSid;
          base.sidHash = hashSid(rawSid);
        } catch (err) {
          // If the DeviceSession write fails the JWT is still issued — but
          // without a sid claim, the validation branch below treats it as
          // "legacy / pre-RFC-0002 token" and lets it through one time.
          logger.error({ err, userId: base.id }, 'device-session-create-failed');
        }
      }

      // Re-validate every subsequent call against the DB so revoked tokens
      // (sessionVersion bump) get hard-killed. One indexed PK lookup; cheap.
      if (!user && base.id) {
        const fresh = await prisma.user.findUnique({
          where: { id: base.id as string },
          select: { sessionVersion: true, role: true },
        });
        if (!fresh) {
          // User was deleted — invalidate the token entirely.
          return null;
        }
        if (fresh.sessionVersion !== base.sessionVersion) {
          return null;
        }
        // Reflect current role in the token (e.g. an admin promotion takes
        // effect on the next request without forcing a re-login).
        base.role = fresh.role;

        // ── Per-session sid validation ────────────────────────────────
        //
        // Tokens that pre-date PR-1 don't carry a sid; let them through
        // until their natural rotation. New tokens must point at an
        // unrevoked DeviceSession row, otherwise we hard-reject (= forced
        // re-login on the next request).
        if (typeof base.sid === 'string' && base.sid.length > 0) {
          const result = await validateDeviceSession(base.sid);
          if (!result.ok) {
            return null;
          }
          // Keep sidHash in sync with the rolled jwt — the session callback
          // (edge-safe) reads this to flag the "current" device in the UI.
          base.sidHash = result.sidHash;
        }
      }

      return base;
    },
  },
});
