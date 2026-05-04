'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { env } from '@/env';
import { recordAudit } from '@/services/audit';
import { update as updateAuthSession } from '@/lib/auth';
import {
  base32Encode,
  buildOtpauthUri,
  decryptSecret,
  encryptSecret,
  findBackupCodeHash,
  generateBackupCodes,
  generateTotpSecret,
  verifyTotp,
} from '@/lib/auth/2fa-crypto';
import { requireActiveOrg, requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { sendTwoFactorEnabledEmail, sendTwoFactorDisabledEmail } from '@/lib/auth/email-flows';

/**
 * RFC 0002 PR-2 — 2FA 注册 / 验证 / 禁用 / 重新生成流程。
 *
 * 两个状态图需要记住：
 *
 *   TwoFactorSecret 行      User.twoFactorEnabled
 *   ──────────────         ─────────────────────
 *   不存在               ↔  false   （从不注册或已禁用）
 *   存在，enabledAt=null ↔  false   （注册已开始，等待确认）
 *   存在，enabledAt 已设置 ↔ true    （活跃）
 *
 *   JWT token.tfa_pending
 *   ─────────────────────
 *   undefined / false  →  无需挑战（用户无 2FA）
 *   true               →  用户必须下一步访问 /login/2fa；页面调用
 *                         `verifyTfaForCurrentSessionAction` 清除它。
 */

const codeSchema = z.object({
  code: z
    .string()
    .min(6)
    .max(20)
    .transform((s) => s.replace(/\s+/g, '')),
});

const verifySchema = z.object({
  code: z.string().min(6).max(20),
});

const TFA_ISSUER = 'Kitora';

/**
 * 注册的第 1 步。生成新秘密 + 10 个备份码，以半注册状态（`enabledAt = null`）
 * 持久化它们，并返回 UI 需要渲染的值（用于 QR 码/手动输入的 otpauth URI、
 * 纯备份码 — 仅显示一次，永不再次显示）。
 */
export async function enrollStartAction() {
  const me = await requireUser();
  if (!me.email) {
    return { ok: false as const, error: 'no-email' as const };
  }

  // 已完全启用？退出；强制禁用后重新启用，以便劫持登录会话的攻击者
  // 无法默默旋转现有 2FA 设置的 TOTP 秘密。
  const existing = await prisma.twoFactorSecret.findUnique({ where: { userId: me.id } });
  if (existing?.enabledAt) {
    return { ok: false as const, error: 'already-enabled' as const };
  }

  const secret = generateTotpSecret();
  const enc = encryptSecret(me.id, secret);
  const { plain: backupPlain, hashes: backupHashes } = generateBackupCodes();

  await prisma.twoFactorSecret.upsert({
    where: { userId: me.id },
    create: {
      userId: me.id,
      encSecret: enc,
      backupHashes,
      enabledAt: null,
    },
    update: {
      // 如果用户点击"启用"两次，重新滚动进行中的注册。
      encSecret: enc,
      backupHashes,
      enabledAt: null,
    },
  });

  const otpauthUri = buildOtpauthUri({
    secret,
    accountLabel: me.email,
    issuer: TFA_ISSUER,
  });

  return {
    ok: true as const,
    otpauthUri,
    // Base32 秘密字符串用于手动输入 — 来自我们刚刚加密的同一缓冲区，
    // 所以我们无需解密往返此处。
    secret: base32Encode(secret),
    backupCodes: backupPlain,
  };
}

/**
 * 注册的第 2 步。用户从其认证器键入前 6 位数代码；我们对照
 * 半注册秘密验证，成功时，在单个事务中翻转 `enabledAt` + `User.twoFactorEnabled`。
 *
 * 注意：备份码已在第 1 步显示 — 我们此处不重新发出。
 * UI 流程：enrollStart → 显示秘密 + 备份码 → enrollConfirm。
 */
export async function enrollConfirmAction(input: z.infer<typeof codeSchema>) {
  const me = await requireUser();
  const parsed = codeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const row = await prisma.twoFactorSecret.findUnique({ where: { userId: me.id } });
  if (!row) {
    return { ok: false as const, error: 'not-enrolled' as const };
  }
  if (row.enabledAt) {
    return { ok: false as const, error: 'already-enabled' as const };
  }

  const secret = decryptSecret(me.id, Buffer.from(row.encSecret));
  if (!verifyTotp(secret, parsed.data.code)) {
    return { ok: false as const, error: 'wrong-code' as const };
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.twoFactorSecret.update({
      where: { userId: me.id },
      data: { enabledAt: now },
    }),
    prisma.user.update({
      where: { id: me.id },
      data: { twoFactorEnabled: true },
    }),
  ]);

  // 将当前会话标记为已验证，使 jwt 回调不会立即设置 `tfa_pending = true`
  // 并将用户弹回 /login/2fa。他们刚刚在这个很请求中证明了 TOTP 秘密的拥有权 —
  // 在注册后立即重新挑战他们是刺耳且错误的。
  await updateAuthSession({ tfa: 'verified' } as unknown as Parameters<
    typeof updateAuthSession
  >[0]).catch(() => {});

  await recordAudit({
    actorId: me.id,
    action: '2fa.enabled',
    target: me.id,
  });
  // 通知账户所有者 — 防守性措施，以防此注册由劫持认证会话的人发起。
  if (me.email) {
    void sendTwoFactorEnabledEmail({
      id: me.id,
      email: me.email,
      name: me.name ?? null,
    }).catch((err) => logger.error({ err, userId: me.id }, '2fa-enabled-email-failed'));
  }

  revalidatePath('/settings');
  return { ok: true as const };
}

/**
 * 禁用 2FA。需要新鲜的 TOTP / 备份码，使被盗会话无法轻易将其关闭。
 * 直接清除秘密 + 备份码；重新启用再次通过 enrollStart。
 */
export async function disableAction(input: z.infer<typeof codeSchema>) {
  const me = await requireActiveOrg();
  const parsed = codeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const row = await prisma.twoFactorSecret.findUnique({
    where: { userId: me.userId },
    select: { encSecret: true, enabledAt: true, backupHashes: true },
  });
  if (!row?.enabledAt) {
    return { ok: false as const, error: 'not-enabled' as const };
  }

  const matchedByTotp = verifyTotp(
    decryptSecret(me.userId, Buffer.from(row.encSecret)),
    parsed.data.code,
  );
  const matchedHash = matchedByTotp ? null : findBackupCodeHash(parsed.data.code, row.backupHashes);
  if (!matchedByTotp && !matchedHash) {
    return { ok: false as const, error: 'wrong-code' as const };
  }

  await prisma.$transaction([
    prisma.twoFactorSecret.delete({ where: { userId: me.userId } }),
    prisma.user.update({
      where: { id: me.userId },
      data: { twoFactorEnabled: false },
    }),
  ]);

  await updateAuthSession({}).catch(() => {});

  await recordAudit({
    actorId: me.userId,
    orgId: me.orgId,
    action: '2fa.disabled',
    target: me.userId,
  });

  // 单独查找电子邮件 — 我们故意保持 requireActiveOrg 精简。
  const u = await prisma.user.findUnique({
    where: { id: me.userId },
    select: { email: true, name: true },
  });
  if (u?.email) {
    void sendTwoFactorDisabledEmail({
      id: me.userId,
      email: u.email,
      name: u.name,
    }).catch((err) => logger.error({ err, userId: me.userId }, '2fa-disabled-email-failed'));
  }

  revalidatePath('/settings');
  return { ok: true as const };
}

/**
 * 重新生成 10 个一次性备份码。返回新鲜的纯文本列表，使 UI 可显示一次。
 * 旧码立即失效。
 */
export async function regenerateBackupCodesAction() {
  const me = await requireUser();
  const row = await prisma.twoFactorSecret.findUnique({ where: { userId: me.id } });
  if (!row?.enabledAt) {
    return { ok: false as const, error: 'not-enabled' as const };
  }

  const { plain, hashes } = generateBackupCodes();
  await prisma.twoFactorSecret.update({
    where: { userId: me.id },
    data: { backupHashes: hashes },
  });

  await recordAudit({
    actorId: me.id,
    action: '2fa.backup_regenerated',
    target: me.id,
  });

  return { ok: true as const, backupCodes: plain };
}

/**
 * 从 `/login/2fa` 调用，用户在键入其代码后。成功时：
 *   1. 更新 JWT，使 `tfa_pending` 变为 false。
 *   2. 在秘密行上提升 `lastUsedAt`（审计友好）。
 *   3. 如使用了备份码，从数组中删除它（一次性）。
 *
 * 这是唯一翻转 `tfa_pending` 的路径 — 页面本身不触及声明。返回 `ok: true`
 * 使调用者可重定向。
 */
export async function verifyTfaForCurrentSessionAction(input: z.infer<typeof verifySchema>) {
  const me = await requireUser();
  const parsed = verifySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const row = await prisma.twoFactorSecret.findUnique({
    where: { userId: me.id },
    select: { encSecret: true, enabledAt: true, backupHashes: true },
  });
  if (!row?.enabledAt) {
    return { ok: false as const, error: 'not-enabled' as const };
  }

  const matchedByTotp = verifyTotp(
    decryptSecret(me.id, Buffer.from(row.encSecret)),
    parsed.data.code,
  );
  const matchedHash = matchedByTotp ? null : findBackupCodeHash(parsed.data.code, row.backupHashes);
  if (!matchedByTotp && !matchedHash) {
    logger.warn({ userId: me.id }, '2fa-challenge-failed');
    return { ok: false as const, error: 'wrong-code' as const };
  }

  if (matchedHash) {
    // 一次性：从数组中删除匹配的哈希。
    await prisma.twoFactorSecret.update({
      where: { userId: me.id },
      data: {
        backupHashes: (row.backupHashes as string[]).filter((h: string) => h !== matchedHash),
        lastUsedAt: new Date(),
      },
    });
  } else {
    await prisma.twoFactorSecret.update({
      where: { userId: me.id },
      data: { lastUsedAt: new Date() },
    });
  }

  // 翻转 JWT 声明。`unstable_update` 使用 `trigger='update'` 重新运行 jwt 回调；
  // 我们在 index.ts 内读取标志并在那里清除 tfa_pending。会话有效负载接受
  // 运行时的任意键 — 通过 `unknown` 强制转换，我们无需扩展类型化的
  // Session 形状仅为了支持临时标志。
  await updateAuthSession({ tfa: 'verified' } as unknown as Parameters<
    typeof updateAuthSession
  >[0]);

  return { ok: true as const, env: env.NEXT_PUBLIC_APP_URL };
}
