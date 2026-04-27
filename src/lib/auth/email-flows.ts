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
 * 异步发送欢迎邮件。传递失败被吞掉（记录） —
 * 不稳定的邮件提供商不能阻止注册流程。
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
 * 为用户签发一个新鲜的邮箱验证令牌并发送验证邮件。
 * 同一用户的旧令牌被撤销以保持表小并防止旧链接跨的重放。
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
 * RFC 0002 PR-2 — 在确认 2FA 注册后立即发送的异步警告。
 * 如果被劫持的会话在真正的所有者不知情的情况下启用 2FA，
 * 则充当绊索。失败被记录，从不抛出 — 认证流不能
 * 因邮件提供商故障而阻塞。
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
 * RFC 0002 PR-2 — 无论何时移除 2FA 时发送的异步警告
 * （由用户自己或管理员在恢复期间发送）。同启用邮件一样的
 * 吞掉失败立场。
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
 * 签发一个新鲜的密码重置令牌并发送重置邮件。总是返回
 * void — 调用者应该给用户一个通用成功消息
 * （不要泄露电子邮件是否存在于系统中）。
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
 * RFC 0002 PR-3 — 当 cron 工作程序完成数据导出时发送的异步通知。
 * 下载链接通过认证门控路由（`/api/exports/[jobId]/download`），
 * 所以即使邮件送到了错误的收件箱，收件人仍需登录才能获取文件。
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
 * RFC 0002 PR-4 — 当用户安排账户删除时发送。充当绊索：
 * 如果收件人没有请求它，邮件中的链接会将他们直接带回
 * /settings 以取消。
 */
export async function sendAccountDeletionScheduledEmail(user: UserLike, scheduledFor: Date) {
  try {
    await sendEmail({
      to: user.email,
      subject: 'Your Kitora account is scheduled for deletion',
      react: AccountDeletionScheduledEmail({
        name: user.name ?? undefined,
        appUrl: env.NEXT_PUBLIC_APP_URL,
        // ISO 日期字符串跨区域是明确的 — 如果我们为电子邮件
        // 模板添加 i18n，邮件正文可以稍后改进为区域感知格式。
        scheduledFor: scheduledFor.toISOString().slice(0, 10),
      }),
    });
  } catch (error) {
    logger.error({ err: error, userId: user.id }, 'account-deletion-scheduled-email-failed');
  }
}

/**
 * RFC 0002 PR-4 — 当用户取消其计划删除时发送。
 * 通过点击收件箱来确认应用内操作，有用于审计跟踪。
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
