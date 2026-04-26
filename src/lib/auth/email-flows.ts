import 'server-only';

import { env } from '@/env';
import { prisma } from '@/lib/db';
import AccountDeletionCancelledEmail from '@/emails/account-deletion-cancelled';
import AccountDeletionScheduledEmail from '@/emails/account-deletion-scheduled';
import DataExportReadyEmail from '@/emails/data-export-ready';
import ResetPasswordEmail from '@/emails/reset-password';
import TwoFactorDisabledEmail from '@/emails/two-factor-disabled';
import TwoFactorEnabledEmail from '@/emails/two-factor-enabled';
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
 * RFC 0002 PR-2 — fire-and-forget alert sent right after 2FA enrollment is
 * confirmed. Acts as a tripwire if a hijacked session enables 2FA without
 * the real owner knowing. Failures are logged, never thrown — auth flow
 * must not block on mail provider hiccups.
 */
export async function sendTwoFactorEnabledEmail(user: UserLike) {
  try {
    await sendEmail({
      to: user.email,
      subject: 'Two-factor authentication enabled',
      react: TwoFactorEnabledEmail({
        name: user.name ?? undefined,
        appUrl: env.NEXT_PUBLIC_APP_URL,
      }),
    });
  } catch (error) {
    logger.error({ err: error, userId: user.id }, 'two-factor-enabled-email-failed');
  }
}

/**
 * RFC 0002 PR-2 — fire-and-forget alert sent whenever 2FA is removed (by
 * the user themselves or by an admin during recovery). Same swallow-on-fail
 * stance as the enabled email.
 */
export async function sendTwoFactorDisabledEmail(user: UserLike, opts: { byAdmin?: boolean } = {}) {
  try {
    await sendEmail({
      to: user.email,
      subject: 'Two-factor authentication disabled',
      react: TwoFactorDisabledEmail({
        name: user.name ?? undefined,
        appUrl: env.NEXT_PUBLIC_APP_URL,
        byAdmin: opts.byAdmin,
      }),
    });
  } catch (error) {
    logger.error({ err: error, userId: user.id }, 'two-factor-disabled-email-failed');
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

/**
 * RFC 0002 PR-3 — fire-and-forget notification when the cron worker
 * finishes a data export. The download link goes through the auth-gated
 * route (`/api/exports/[jobId]/download`), so even if the email lands in
 * the wrong inbox the recipient still has to sign in to grab the file.
 */
export async function sendDataExportReadyEmail(
  user: UserLike,
  opts: { jobId: string; scope: 'USER' | 'ORG' },
) {
  try {
    const downloadUrl = `${env.NEXT_PUBLIC_APP_URL}/api/exports/${opts.jobId}/download`;
    await sendEmail({
      to: user.email,
      subject: 'Your data export is ready',
      react: DataExportReadyEmail({
        name: user.name ?? undefined,
        appUrl: env.NEXT_PUBLIC_APP_URL,
        downloadUrl,
        scope: opts.scope,
      }),
    });
  } catch (error) {
    logger.error({ err: error, userId: user.id }, 'data-export-ready-email-failed');
  }
}

/**
 * RFC 0002 PR-4 — sent when a user schedules account deletion. Acts as a
 * tripwire: if the recipient didn't request it, the link in the email
 * brings them straight back to /settings to cancel.
 */
export async function sendAccountDeletionScheduledEmail(user: UserLike, scheduledFor: Date) {
  try {
    await sendEmail({
      to: user.email,
      subject: 'Your Kitora account is scheduled for deletion',
      react: AccountDeletionScheduledEmail({
        name: user.name ?? undefined,
        appUrl: env.NEXT_PUBLIC_APP_URL,
        // ISO date string is unambiguous across locales — the email body
        // can be improved later with locale-aware formatting if we add
        // i18n to email templates.
        scheduledFor: scheduledFor.toISOString().slice(0, 10),
      }),
    });
  } catch (error) {
    logger.error({ err: error, userId: user.id }, 'account-deletion-scheduled-email-failed');
  }
}

/**
 * RFC 0002 PR-4 — sent when a user cancels their scheduled deletion.
 * Confirms the in-app action by hitting the inbox too, useful as an
 * audit trail.
 */
export async function sendAccountDeletionCancelledEmail(user: UserLike) {
  try {
    await sendEmail({
      to: user.email,
      subject: 'Your Kitora account deletion has been cancelled',
      react: AccountDeletionCancelledEmail({ name: user.name ?? undefined }),
    });
  } catch (error) {
    logger.error({ err: error, userId: user.id }, 'account-deletion-cancelled-email-failed');
  }
}
