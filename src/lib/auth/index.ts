import { PrismaAdapter } from '@auth/prisma-adapter';
import { OrgRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { headers } from 'next/headers';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

import { authConfig } from './config';
import { createDeviceSession, generateSid, hashSid, validateDeviceSession } from './device-session';

// RFC 0004 PR-2 — surfaced through Auth.js's `CredentialsSignin.code` so the
// `loginAction` server action can map it to a `sso-required` reason for the
// UI's "your org requires SSO" rail.
class SsoRequiredError extends CredentialsSignin {
  code = 'sso_required';
}

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

        // RFC 0004 PR-2 — enforce SSO. If this user belongs to ANY org that's
        // flipped `enforceForLogin = true` and that IdP is `enabledAt`-active,
        // the password path is closed. OWNERs of such orgs are exempt — we
        // don't want an IdP outage to lock the keeper-of-keys out (mirrors
        // the SSO RFC §11 decision).
        const enforcing = await prisma.identityProvider.findFirst({
          where: {
            enforceForLogin: true,
            enabledAt: { not: null },
            organization: {
              memberships: {
                some: {
                  userId: user.id,
                  role: { not: OrgRole.OWNER },
                },
              },
            },
          },
          select: { id: true, organization: { select: { slug: true } } },
        });
        if (enforcing) {
          logger.info(
            { userId: user.id, providerId: enforcing.id },
            'sso-enforced-credentials-blocked',
          );
          throw new SsoRequiredError();
        }

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          role: user.role,
          sessionVersion: user.sessionVersion,
          twoFactorEnabled: user.twoFactorEnabled,
          status: user.status,
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
          select: {
            sessionVersion: true,
            role: true,
            twoFactorEnabled: true,
            status: true,
          },
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
        // RFC 0002 PR-4 — keep `status` in sync so middleware sees the
        // PENDING_DELETION flip the moment the action commits, no need
        // to wait for a fresh JWT mint.
        base.status = fresh.status;

        // ── RFC 0002 PR-2: tfa_pending state machine ──────────────────
        //
        // Three transitions handled here:
        //   (a) `update` trigger with `session.tfa === 'verified'` clears
        //       the flag — that's the success path of /login/2fa.
        //   (b) 2FA was just disabled (DB says false) → clear the flag so
        //       the user isn't stuck on the challenge page.
        //   (c) 2FA was just enabled mid-session → set the flag so the
        //       user is bumped to the challenge before any further action.
        if (trigger === 'update' && (session as { tfa?: string } | undefined)?.tfa === 'verified') {
          base.tfa_pending = false;
        } else if (!fresh.twoFactorEnabled) {
          base.tfa_pending = false;
        } else if (fresh.twoFactorEnabled && base.tfa_pending !== false) {
          // Pre-existing tokens (predating PR-2) won't have tfa_pending set
          // at all. Treat undefined as "needs challenge" the moment 2FA is
          // on, so users who enabled 2FA can't bypass with old tokens.
          if (base.tfa_pending === undefined) {
            base.tfa_pending = true;
          }
        }

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
