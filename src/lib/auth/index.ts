import { PrismaAdapter } from '@auth/prisma-adapter';
import bcrypt from 'bcryptjs';
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

import { authConfig } from './config';

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
      }

      return base;
    },
  },
});
