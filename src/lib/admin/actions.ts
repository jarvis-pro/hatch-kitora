'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { auth } from '@/lib/auth';
import { sendTwoFactorDisabledEmail } from '@/lib/auth/email-flows';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

const setRoleSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(['USER', 'ADMIN']),
});

const resetTfaSchema = z.object({
  userId: z.string().min(1),
});

/** Require ADMIN session — throws (caller should never reach unauthorized). */
async function requireAdmin() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    throw new Error('forbidden');
  }
  return session.user;
}

export async function setUserRoleAction(input: z.infer<typeof setRoleSchema>) {
  const me = await requireAdmin();

  const parsed = setRoleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  // Prevent admins from accidentally demoting themselves.
  if (parsed.data.userId === me.id && parsed.data.role !== 'ADMIN') {
    return { ok: false as const, error: 'self-demote' as const };
  }

  await prisma.user.update({
    where: { id: parsed.data.userId },
    data: { role: parsed.data.role },
  });

  logger.info(
    { actor: me.id, target: parsed.data.userId, role: parsed.data.role },
    'admin-set-user-role',
  );
  // Platform-level action — actor moves across orgs. orgId stays null per
  // RFC-0001 §4 ("global / platform admin actions allow orgId = null").
  await recordAudit({
    actorId: me.id,
    orgId: null,
    action: 'role.set',
    target: parsed.data.userId,
    metadata: { role: parsed.data.role },
  });

  revalidatePath('/admin/users');
  revalidatePath('/admin/audit');
  return { ok: true as const };
}

/**
 * RFC 0002 PR-2 — platform-admin recovery path for "I lost my authenticator
 * AND my backup codes". After identity has been verified out-of-band (support
 * ticket), an admin clicks a button in `/admin/users/:id` and we wipe the
 * user's TwoFactorSecret + flip `twoFactorEnabled = false`. Audit row attributes
 * the action to the admin actor (target = the user who lost access). Email
 * notification goes to the user with `byAdmin: true` so they know what
 * happened the next time they read their inbox.
 */
export async function resetUserTwoFactorAction(input: z.infer<typeof resetTfaSchema>) {
  const me = await requireAdmin();
  const parsed = resetTfaSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const target = await prisma.user.findUnique({
    where: { id: parsed.data.userId },
    select: { id: true, email: true, name: true, twoFactorEnabled: true },
  });
  if (!target) {
    return { ok: false as const, error: 'not-found' as const };
  }
  if (!target.twoFactorEnabled) {
    return { ok: false as const, error: 'not-enabled' as const };
  }

  // Same-tx wipe: secret row + denormalized flag move together so a partial
  // failure can't leave the user in a "twoFactorEnabled=true with no secret"
  // limbo where they could never log in.
  await prisma.$transaction([
    prisma.twoFactorSecret.delete({ where: { userId: target.id } }),
    prisma.user.update({
      where: { id: target.id },
      data: { twoFactorEnabled: false },
    }),
  ]);

  logger.info({ actor: me.id, target: target.id }, 'admin-2fa-reset');
  await recordAudit({
    actorId: me.id,
    orgId: null,
    action: '2fa.disabled',
    target: target.id,
    metadata: { reason: 'admin-reset' },
  });

  if (target.email) {
    void sendTwoFactorDisabledEmail(
      { id: target.id, email: target.email, name: target.name },
      { byAdmin: true },
    ).catch((err) => logger.error({ err, userId: target.id }, '2fa-disabled-email-failed'));
  }

  revalidatePath('/admin/users');
  revalidatePath('/admin/audit');
  return { ok: true as const };
}
