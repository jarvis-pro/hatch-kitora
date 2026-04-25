import 'server-only';

import { env } from '@/env';
import { prisma } from '@/lib/db';
import ResetPasswordEmail from '@/emails/reset-password';
import VerifyEmail from '@/emails/verify-email';
import WelcomeEmail from '@/emails/welcome';
import { sendEmail } from '@/lib/email/send';
import { logger } from '@/lib/logger';

import { TOKEN_TTL, expiresAt, generateRawToken, hashToken } from './tokens';

interface UserLike {
  id: string;
  email: string;
  name?: string | null;
}

/**
 * Fire-and-forget welcome email. Delivery failures are swallowed (logged) —
 * a flaky mail provider must NOT block the signup flow.
 */
export async function sendWelcomeEmail(user: UserLike) {
  try {
    await sendEmail({
      to: user.email,
      subject: 'Welcome to Kitora',
      react: WelcomeEmail({ name: user.name ?? undefined, appUrl: env.NEXT_PUBLIC_APP_URL }),
    });
  } catch (error) {
    logger.error({ err: error, userId: user.id }, 'welcome-email-send-failed');
  }
}

/**
 * Issue a fresh email-verification token for the user and send the verify
 * email. Old tokens for the same user are invalidated to keep the table small
 * and prevent replay across stale links.
 */
export async function sendVerificationEmail(user: UserLike) {
  const raw = generateRawToken();
  const tokenHash = hashToken(raw);

  await prisma.$transaction([
    prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } }),
    prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expires: expiresAt(TOKEN_TTL.emailVerification),
      },
    }),
  ]);

  const verifyUrl = `${env.NEXT_PUBLIC_APP_URL}/verify-email?token=${raw}`;

  try {
    await sendEmail({
      to: user.email,
      subject: 'Verify your email',
      react: VerifyEmail({ verifyUrl, name: user.name ?? undefined }),
    });
  } catch (error) {
    logger.error({ err: error, userId: user.id }, 'verify-email-send-failed');
    throw error;
  }
}

/**
 * Issue a fresh password-reset token and send the reset email. Always returns
 * void — the caller should give a generic success message to the user (do NOT
 * leak whether the email exists in the system).
 */
export async function sendPasswordResetEmail(user: UserLike) {
  const raw = generateRawToken();
  const tokenHash = hashToken(raw);

  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
    prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expires: expiresAt(TOKEN_TTL.passwordReset),
      },
    }),
  ]);

  const resetUrl = `${env.NEXT_PUBLIC_APP_URL}/reset-password?token=${raw}`;

  try {
    await sendEmail({
      to: user.email,
      subject: 'Reset your password',
      react: ResetPasswordEmail({ resetUrl, name: user.name ?? undefined }),
    });
  } catch (error) {
    logger.error({ err: error, userId: user.id }, 'reset-password-send-failed');
    throw error;
  }
}
