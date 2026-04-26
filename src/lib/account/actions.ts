'use server';

import bcrypt from 'bcryptjs';
import { OrgRole } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { signOut } from '@/lib/auth';
import { requireActiveOrg, requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

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
    // Pure OAuth account — no password to change.
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
      // A successful password change invalidates every other JWT.
      sessionVersion: { increment: 1 },
    },
  });

  logger.info({ userId: me.userId }, 'password-changed');
  await recordAudit({
    actorId: me.userId,
    orgId: me.orgId,
    action: 'account.password_changed',
    target: me.userId,
  });
  // The current session's JWT carries the old sessionVersion → it's now
  // invalid too. Sign the user out so the UI redirects cleanly.
  await signOut({ redirectTo: '/login' });
  return { ok: true as const };
}

export async function signOutEverywhereAction() {
  const me = await requireActiveOrg();
  await prisma.user.update({
    where: { id: me.userId },
    data: { sessionVersion: { increment: 1 } },
  });
  logger.info({ userId: me.userId }, 'sign-out-everywhere');
  await recordAudit({
    actorId: me.userId,
    orgId: me.orgId,
    action: 'account.sign_out_everywhere',
    target: me.userId,
  });
  // This call also invalidates the current session — which is consistent with
  // "sign out everywhere" since Edge middleware can't distinguish "current"
  // from "other" device when only the JWT is available.
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
  // Refuse if removing this would leave the user with no way to log in.
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

  // 安全检查：如果用户还是某个**非 personal**组织的 OWNER，直接拒绝删账号 ——
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

  // 记录审计。orgId 写 audit 行的瞬间还有效（Membership 还没删），audit 表
  // 不加 FK，所以 org 删后该行保留。
  await recordAudit({
    actorId: me.userId,
    orgId: me.orgId,
    action: 'account.deleted',
    target: me.userId,
    metadata: { email: sessionUser.email ?? null },
  });

  // 同事务删 personal org（每个 user 至少一个，理论上只有一个）+ user。
  // Cascade 会带走 Account / Session / Subscription / ApiToken / Membership /
  // Invitation。
  const personalOrgIds = ownedMemberships
    .map((m) => m.organization)
    .filter((o) => o.slug.startsWith('personal-'))
    .map((o) => o.id);

  await prisma.$transaction([
    ...personalOrgIds.map((id) => prisma.organization.delete({ where: { id } })),
    prisma.user.delete({ where: { id: me.userId } }),
  ]);
  logger.info(
    { userId: me.userId, personalOrgIds, count: personalOrgIds.length },
    'account-deleted',
  );

  await signOut({ redirectTo: '/' });
  return { ok: true as const };
}
