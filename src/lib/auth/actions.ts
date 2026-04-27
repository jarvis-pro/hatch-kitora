'use server';

import bcrypt from 'bcryptjs';
import { AuthError } from 'next-auth';
import { OrgRole } from '@prisma/client';
import { z } from 'zod';

import { signIn, signOut } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { strictLimiter } from '@/lib/rate-limit';
import { currentRegion } from '@/lib/region';
import { getClientIp } from '@/lib/request';

import { sendPasswordResetEmail, sendVerificationEmail, sendWelcomeEmail } from './email-flows';
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
  // RFC 0005 — 注册是区域范围的：电子邮件在一个区域内是唯一的，
  // 但相同地址可能在另一个区域以独立账户形式存在（kitora.cn vs kitora.io）。
  // 通过复合（email、region）键查找。
  const region = currentRegion();
  const existing = await prisma.user.findUnique({
    where: { email_region: { email, region } },
  });
  if (existing) {
    return { ok: false as const, error: 'email-taken' };
  }

  const passwordHash = await bcrypt.hash(password, 12);
  // 同事务建 user + personal org + OWNER membership —— 第一个请求进 dashboard
  // 时 requireActiveOrg() 即可命中已存在记录，无需 lazy creation。
  // RFC 0005 — User 和 Organization 都携带部署区域；我们在与成员资格行
  // 相同的事务中标记它们。
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({ data: { name, email, passwordHash, region } });
    const slug = `personal-${created.id.slice(-8)}`;
    const org = await tx.organization.create({
      data: { slug, name: name || 'Personal', region },
    });
    await tx.membership.create({
      data: { orgId: org.id, userId: created.id, role: OrgRole.OWNER },
    });
    return created;
  });

  // 发送验证 + 欢迎电子邮件，但若任一失败则不阻止注册 — 用户仍可登录
  // 并请求重新发送验证。
  void sendVerificationEmail(user).catch((err) =>
    logger.error({ err, userId: user.id }, 'signup-verify-send-failed'),
  );
  void sendWelcomeEmail(user);

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
      // RFC 0004 PR-2 — 从 Credentials.authorize 抛出的 `SsoRequiredError`
      // 在此表现为 code = 'sso_required' 的 CredentialsSignin。
      // 我们呈现类型化原因，使 LoginForm 可切换到仅 SSO 轨道而无需
      // 敌意的通用错误 toast。
      const code = (error as { code?: string }).code;
      if (code === 'sso_required') {
        return { ok: false as const, error: 'sso-required', email: parsed.data.email };
      }
      return { ok: false as const, error: error.type };
    }
    throw error;
  }
}

export async function logoutAction() {
  await signOut({ redirectTo: '/' });
}

// ---------------------------------------------------------------------------
// 电子邮件验证
// ---------------------------------------------------------------------------

/**
 * 请求（重新）发送电子邮件验证链接。调用者可能未认证（例如用户丢失了电子邮件）—
 * 我们按电子邮件标识。
 *
 * 响应故意通用：我们**不**透露电子邮件是否存在或已验证。
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

  const user = await prisma.user.findUnique({
    where: { email_region: { email: parsed.data.email, region: currentRegion() } },
  });
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
 * 消费验证令牌。返回判别结果，使页面可为 `expired` / `invalid` 渲染不同副本。
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
// 密码重置
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

  const user = await prisma.user.findUnique({
    where: { email_region: { email: parsed.data.email, region: currentRegion() } },
  });
  // 仅在用户设置了密码时发送；仅 OAuth 用户不知道要重置什么。
  // 无论哪种情况，响应保持通用。
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
        // 成功的重置证明了电子邮件控制权 — 如果尚未标记，也将其标记为已验证。
        emailVerified: new Date(),
      },
    }),
    prisma.passwordResetToken.deleteMany({ where: { userId: record.userId } }),
    // 可选加固：密码更改时使任何活跃会话失效。
    prisma.session.deleteMany({ where: { userId: record.userId } }),
  ]);

  return { ok: true as const };
}
