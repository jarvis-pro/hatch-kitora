'use server';

import bcrypt from 'bcryptjs';
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

  // Record before delete — once the user row is gone we still keep the audit
  // entry referencing the no-longer-existent actorId. orgId 写 audit 行的瞬
  // 间还有效（Membership 还没删），audit 表不加 FK 所以 org 删后该行保留。
  await recordAudit({
    actorId: me.userId,
    orgId: me.orgId,
    action: 'account.deleted',
    target: me.userId,
    metadata: { email: sessionUser.email ?? null },
  });
  // Cascading FKs (Account / Session / Subscription / Membership) take care
  // of the rest. The (now orphan) personal org survives — PR-3 will cascade
  // delete personal orgs as part of the account-removal flow.
  await prisma.user.delete({ where: { id: me.userId } });
  logger.info({ userId: me.userId }, 'account-deleted');

  await signOut({ redirectTo: '/' });
  return { ok: true as const };
}
