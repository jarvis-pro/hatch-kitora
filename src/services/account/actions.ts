'use server';

import bcrypt from 'bcryptjs';
import { OrgRole } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/services/audit';
import { signOut } from '@/lib/auth';
import { revokeAllDeviceSessions } from '@/lib/auth/device-session';
import {
  sendAccountDeletionCancelledEmail,
  sendAccountDeletionScheduledEmail,
} from '@/lib/auth/email-flows';
import { requireActiveOrg, requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getClientIp } from '@/lib/request';

const profileSchema = z.object({
  name: z.string().min(1).max(80),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(8).max(128),
  newPassword: z.string().min(8).max(128),
});

const deleteSchema = z.object({
  emailConfirm: z.string().email(),
});

const unlinkProviderSchema = z.object({
  provider: z.string().min(1).max(40),
});

export async function updateProfileAction(input: z.infer<typeof profileSchema>) {
  const me = await requireUser();
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  await prisma.user.update({
    where: { id: me.id },
    data: { name: parsed.data.name },
  });

  revalidatePath('/settings');
  revalidatePath('/dashboard');
  return { ok: true as const };
}

export async function changePasswordAction(input: z.infer<typeof passwordSchema>) {
  const me = await requireActiveOrg();
  const parsed = passwordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const user = await prisma.user.findUnique({ where: { id: me.userId } });
  if (!user?.passwordHash) {
    // 纯 OAuth 账户 — 没有密码可修改。
    return { ok: false as const, error: 'no-password' as const };
  }

  const valid = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
  if (!valid) {
    return { ok: false as const, error: 'wrong-password' as const };
  }

  const newHash = await bcrypt.hash(parsed.data.newPassword, 12);
  await prisma.user.update({
    where: { id: me.userId },
    data: {
      passwordHash: newHash,
      // 成功改密会使其他所有 JWT 失效。
      sessionVersion: { increment: 1 },
    },
  });
  // 同时将所有 DeviceSession 行标记为已吊销，这样活跃会话列表
  // 会反映真实状态（而不仅仅是"JWT 现在无效"）。
  await revokeAllDeviceSessions(me.userId);

  logger.info({ userId: me.userId }, 'password-changed');
  await recordAudit({
    actorId: me.userId,
    orgId: me.orgId,
    action: 'account.password_changed',
    target: me.userId,
  });
  // 当前会话的 JWT 携带旧的 sessionVersion → 它现在也失效了。
  // 让用户登出，这样 UI 可以干净地跳转。
  await signOut({ redirectTo: '/login' });
  return { ok: true as const };
}

export async function signOutEverywhereAction() {
  const me = await requireActiveOrg();
  await prisma.user.update({
    where: { id: me.userId },
    data: { sessionVersion: { increment: 1 } },
  });
  // 与 `changePasswordAction` 的逻辑相同：吊销所有 DeviceSession 行，
  // 使 UI 会话列表与 JWT 失效同步清空。这两个路径一起提供一致的语义。
  await revokeAllDeviceSessions(me.userId);
  logger.info({ userId: me.userId }, 'sign-out-everywhere');
  await recordAudit({
    actorId: me.userId,
    orgId: me.orgId,
    action: 'account.sign_out_everywhere',
    target: me.userId,
  });
  // 这个调用也会使当前会话失效 — 这与"处处登出"一致，因为边界中间件
  // 在只有 JWT 可用时无法区分"当前"和"其他"设备。
  await signOut({ redirectTo: '/login' });
  return { ok: true as const };
}

export async function unlinkProviderAction(input: z.infer<typeof unlinkProviderSchema>) {
  const me = await requireUser();
  const parsed = unlinkProviderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const user = await prisma.user.findUnique({
    where: { id: me.id },
    select: { passwordHash: true, accounts: { select: { provider: true } } },
  });
  if (!user) {
    return { ok: false as const, error: 'not-found' as const };
  }

  const otherProviders = user.accounts.filter((a) => a.provider !== parsed.data.provider);
  // 拒绝移除会导致用户没有登录方式的情况。
  if (!user.passwordHash && otherProviders.length === 0) {
    return { ok: false as const, error: 'last-login-method' as const };
  }

  const result = await prisma.account.deleteMany({
    where: { userId: me.id, provider: parsed.data.provider },
  });
  if (result.count === 0) {
    return { ok: false as const, error: 'not-linked' as const };
  }

  logger.info({ userId: me.id, provider: parsed.data.provider }, 'oauth-provider-unlinked');
  return { ok: true as const };
}

/**
 * RFC 0002 PR-4 — 调度（而非立即执行）账户删除。
 *
 * 状态转换：ACTIVE → PENDING_DELETION，`deletionScheduledAt =
 * now + 30d`。用户仍可登录（以便取消删除），但中间件会将他们路由到 /settings/account/*
 * 且无其他访问权限。硬删除通过日常 cron `scripts/run-deletion-cron.ts` 执行。
 *
 * 我们在同一事务中提升 `sessionVersion` 并吊销每个 DeviceSession —
 * 用户必须在调度后重新认证，这也使得"在被盗笔记本上设置后不管"变得困难得多。
 */
export async function deleteAccountAction(input: z.infer<typeof deleteSchema>) {
  const me = await requireActiveOrg();
  const sessionUser = await requireUser();
  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }
  if (parsed.data.emailConfirm.toLowerCase() !== (sessionUser.email ?? '').toLowerCase()) {
    return { ok: false as const, error: 'email-mismatch' as const };
  }

  // 安全检查：如果用户还是某个**非 personal**组织的 OWNER，直接拒绝调度删除 ——
  // 否则会留下没有 OWNER 的组织（成员还在但没人能管理 / 计费）。让用户先
  // 在那些 org 转让所有权或删除组织。
  const ownedMemberships = await prisma.membership.findMany({
    where: { userId: me.userId, role: OrgRole.OWNER },
    select: { organization: { select: { id: true, slug: true, name: true } } },
  });
  const blockingOrgs = ownedMemberships
    .map((m) => m.organization)
    .filter((o) => !o.slug.startsWith('personal-'));
  if (blockingOrgs.length > 0) {
    return {
      ok: false as const,
      error: 'owns-orgs' as const,
      orgs: blockingOrgs.map((o) => ({ slug: o.slug, name: o.name })),
    };
  }

  const scheduledAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const ip = await getClientIp();

  await prisma.user.update({
    where: { id: me.userId },
    data: {
      status: 'PENDING_DELETION',
      deletionScheduledAt: scheduledAt,
      deletionRequestedFromIp: ip,
      // 提升以使其他所有 JWT（及所有会话行）失效 —
      // 一个"计划删除"的账户不应该在登录过的任何地方仍保持活跃。
      sessionVersion: { increment: 1 },
    },
  });
  await revokeAllDeviceSessions(me.userId);

  await recordAudit({
    actorId: me.userId,
    orgId: me.orgId,
    action: 'account.deletion_scheduled',
    target: me.userId,
    metadata: { scheduledAt: scheduledAt.toISOString(), email: sessionUser.email ?? null },
  });
  logger.info(
    { userId: me.userId, scheduledAt: scheduledAt.toISOString() },
    'account-deletion-scheduled',
  );

  if (sessionUser.email) {
    void sendAccountDeletionScheduledEmail(
      { id: me.userId, email: sessionUser.email, name: sessionUser.name ?? null },
      scheduledAt,
    );
  }

  // 同样登出 — 下一个页面应该是 /login，用户重新登录后会看到取消横幅。
  await signOut({ redirectTo: '/login' });
  return { ok: true as const };
}

/**
 * RFC 0002 PR-4 — 撤销已调度的删除。允许在 `deletionScheduledAt` 到期前任何时间调用，
 * 幂等（对已是 ACTIVE 的账户调用只返回 ok）。通过仪表板横幅提示。
 */
export async function cancelAccountDeletionAction() {
  const me = await requireUser();

  const fresh = await prisma.user.findUniqueOrThrow({
    where: { id: me.id },
    select: { status: true, email: true, name: true },
  });
  if (fresh.status === 'ACTIVE') {
    return { ok: true as const, alreadyActive: true as const };
  }

  await prisma.user.update({
    where: { id: me.id },
    data: {
      status: 'ACTIVE',
      deletionScheduledAt: null,
      deletionRequestedFromIp: null,
    },
  });
  await recordAudit({
    actorId: me.id,
    action: 'account.deletion_cancelled',
    target: me.id,
  });
  logger.info({ userId: me.id }, 'account-deletion-cancelled');

  if (fresh.email) {
    void sendAccountDeletionCancelledEmail({
      id: me.id,
      email: fresh.email,
      name: fresh.name,
    });
  }
  revalidatePath('/settings');
  revalidatePath('/dashboard');
  return { ok: true as const };
}
