'use server';

import bcrypt from 'bcryptjs';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { auth, signOut } from '@/lib/auth';
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

async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error('unauthenticated');
  }
  return session.user;
}

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
  const me = await requireUser();
  const parsed = passwordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const user = await prisma.user.findUnique({ where: { id: me.id } });
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
    where: { id: me.id },
    data: {
      passwordHash: newHash,
      // A successful password change invalidates every other JWT.
      sessionVersion: { increment: 1 },
    },
  });

  logger.info({ userId: me.id }, 'password-changed');
  await recordAudit({ actorId: me.id, action: 'account.password_changed', target: me.id });
  // The current session's JWT carries the old sessionVersion → it's now
  // invalid too. Sign the user out so the UI redirects cleanly.
  await signOut({ redirectTo: '/login' });
  return { ok: true as const };
}

export async function signOutEverywhereAction() {
  const me = await requireUser();
  await prisma.user.update({
    where: { id: me.id },
    data: { sessionVersion: { increment: 1 } },
  });
  logger.info({ userId: me.id }, 'sign-out-everywhere');
  await recordAudit({ actorId: me.id, action: 'account.sign_out_everywhere', target: me.id });
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
  const me = await requireUser();
  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }
  if (parsed.data.emailConfirm.toLowerCase() !== (me.email ?? '').toLowerCase()) {
    return { ok: false as const, error: 'email-mismatch' as const };
  }

  // Record before delete — once the user row is gone we still keep the audit
  // entry referencing the no-longer-existent actorId.
  await recordAudit({
    actorId: me.id,
    action: 'account.deleted',
    target: me.id,
    metadata: { email: me.email ?? null },
  });
  // Cascading FKs (Account / Session / Subscription) take care of the rest.
  await prisma.user.delete({ where: { id: me.id } });
  logger.info({ userId: me.id }, 'account-deleted');

  await signOut({ redirectTo: '/' });
  return { ok: true as const };
}
