'use server';

import bcrypt from 'bcryptjs';
import { AuthError } from 'next-auth';
import { z } from 'zod';

import { signIn, signOut } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { strictLimiter } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/request';

import { sendPasswordResetEmail, sendVerificationEmail } from './email-flows';
import { hashToken } from './tokens';

const signupSchema = z.object({
  name: z.string().min(1).max(80),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const emailSchema = z.object({ email: z.string().email() });

const tokenSchema = z.object({ token: z.string().min(16).max(128) });

const resetPasswordSchema = z.object({
  token: z.string().min(16).max(128),
  password: z.string().min(8).max(128),
});

export async function signupAction(input: z.infer<typeof signupSchema>) {
  const parsed = signupSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' };
  }

  const { name, email, password } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { ok: false as const, error: 'email-taken' };
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { name, email, passwordHash },
  });

  // Fire the verification email but don't block signup if it fails — the user
  // can request a fresh link from /verify-email.
  void sendVerificationEmail(user).catch((err) =>
    logger.error({ err, userId: user.id }, 'signup-verify-send-failed'),
  );

  try {
    await signIn('credentials', {
      email,
      password,
      redirect: false,
    });
    return { ok: true as const };
  } catch (error) {
    logger.error({ err: error }, 'signup-signin-failed');
    return { ok: true as const, requiresLogin: true };
  }
}

export async function loginAction(input: z.infer<typeof loginSchema>) {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' };
  }

  try {
    await signIn('credentials', {
      ...parsed.data,
      redirect: false,
    });
    return { ok: true as const };
  } catch (error) {
    if (error instanceof AuthError) {
      return { ok: false as const, error: error.type };
    }
    throw error;
  }
}

export async function logoutAction() {
  await signOut({ redirectTo: '/' });
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

/**
 * Request a (re-)send of the email verification link. Caller may be
 * unauthenticated (e.g. user lost the email) — we identify by email.
 *
 * The response is intentionally generic: we do NOT reveal whether the email
 * exists or whether it's already verified.
 */
export async function requestEmailVerificationAction(input: { email: string }) {
  const parsed = emailSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' };
  }

  const ip = await getClientIp();
  const { success } = await strictLimiter.limit(`verify-req:${ip}`);
  if (!success) {
    return { ok: false as const, error: 'rate-limited' };
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (user && !user.emailVerified) {
    try {
      await sendVerificationEmail(user);
    } catch (err) {
      logger.error({ err, userId: user.id }, 'verify-email-resend-failed');
    }
  }

  return { ok: true as const };
}

/**
 * Consume a verification token. Returns a discriminated result so the page
 * can render distinct copy for `expired` / `invalid`.
 */
export async function verifyEmailAction(input: { token: string }) {
  const parsed = tokenSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid' as const };
  }

  const tokenHash = hashToken(parsed.data.token);
  const record = await prisma.emailVerificationToken.findUnique({ where: { tokenHash } });
  if (!record) {
    return { ok: false as const, error: 'invalid' as const };
  }

  if (record.consumedAt) {
    return { ok: false as const, error: 'invalid' as const };
  }

  if (record.expires.getTime() < Date.now()) {
    return { ok: false as const, error: 'expired' as const };
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { emailVerified: new Date() },
    }),
    prisma.emailVerificationToken.deleteMany({ where: { userId: record.userId } }),
  ]);

  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

export async function requestPasswordResetAction(input: { email: string }) {
  const parsed = emailSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' };
  }

  const ip = await getClientIp();
  const { success } = await strictLimiter.limit(`pwreset-req:${ip}`);
  if (!success) {
    return { ok: false as const, error: 'rate-limited' };
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  // Only send if the user has a password set; OAuth-only users wouldn't know
  // what to reset. Either way the response stays generic.
  if (user?.passwordHash) {
    try {
      await sendPasswordResetEmail(user);
    } catch (err) {
      logger.error({ err, userId: user.id }, 'password-reset-send-failed');
    }
  }

  return { ok: true as const };
}

export async function resetPasswordAction(input: z.infer<typeof resetPasswordSchema>) {
  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const tokenHash = hashToken(parsed.data.token);
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
  if (!record || record.consumedAt) {
    return { ok: false as const, error: 'invalid' as const };
  }
  if (record.expires.getTime() < Date.now()) {
    return { ok: false as const, error: 'expired' as const };
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: {
        passwordHash,
        // A successful reset proves email control — mark as verified too if
        // it wasn't already.
        emailVerified: new Date(),
      },
    }),
    prisma.passwordResetToken.deleteMany({ where: { userId: record.userId } }),
    // Optional hardening: invalidate any active sessions on password change.
    prisma.session.deleteMany({ where: { userId: record.userId } }),
  ]);

  return { ok: true as const };
}
