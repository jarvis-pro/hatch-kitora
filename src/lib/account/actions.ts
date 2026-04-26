'use server';

import bcrypt from 'bcryptjs';
import { OrgRole } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
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
  // Also flip every DeviceSession row to revoked so the active-sessions
  // list reflects the truth (not just "JWT now invalid").
  await revokeAllDeviceSessions(me.userId);

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
  // Same rationale as in `changePasswordAction`: revoke all DeviceSession
  // rows so the UI sessions list goes empty in lockstep with the JWT
  // invalidation. The two paths together give consistent semantics.
  await revokeAllDeviceSessions(me.userId);
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

/**
 * RFC 0002 PR-4 — schedule (not immediately execute) account deletion.
 *
 * State transition: ACTIVE → PENDING_DELETION with `deletionScheduledAt =
 * now + 30d`. The user can still sign in (so they can cancel), but the
 * middleware will route them to /settings/account/* and nothing else.
 * Hard-delete happens via the daily cron `scripts/run-deletion-cron.ts`.
 *
 * We bump `sessionVersion` and revoke every DeviceSession in the same
 * transaction — the user must re-authenticate after scheduling, which
 * also makes "fire-and-forget on a stolen laptop" much harder.
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
      // Bump so every other JWT (and every other session row) becomes
      // invalid — a "scheduled-for-delete" account should not stay live
      // anywhere it was logged in.
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

  // signOut here too — the next page should be /login, where the user
  // signs back in to land on the cancellation banner.
  await signOut({ redirectTo: '/login' });
  return { ok: true as const };
}

/**
 * RFC 0002 PR-4 — undo a scheduled deletion. Allowed any time before
 * `deletionScheduledAt` lapses, idempotent (calling on an already-ACTIVE
 * account just returns ok). Surfaced via the dashboard banner.
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
