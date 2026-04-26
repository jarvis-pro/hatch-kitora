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

const jobIdSchema = z.object({ jobId: z.string().min(1) });

/**
 * RFC 0008 §4.8 / PR-4 — admin manual cancel：把一行（DEAD_LETTER 或 PENDING）
 * 翻 CANCELED，写 audit `job.cancelled`。RUNNING 行不能 cancel —— 等当次结束。
 */
export async function cancelJobAction(input: z.infer<typeof jobIdSchema>) {
  const me = await requireAdmin();
  const parsed = jobIdSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const result = await prisma.backgroundJob.updateMany({
    where: { id: parsed.data.jobId, status: { in: ['DEAD_LETTER', 'PENDING'] } },
    data: {
      status: 'CANCELED',
      completedAt: new Date(),
      lockedBy: null,
      lockedAt: null,
    },
  });

  if (result.count === 0) {
    return { ok: false as const, error: 'not-found-or-not-cancelable' as const };
  }

  logger.info({ actor: me.id, jobId: parsed.data.jobId }, 'admin-job-cancelled');
  await recordAudit({
    actorId: me.id,
    orgId: null,
    action: 'job.cancelled',
    target: parsed.data.jobId,
  });

  revalidatePath('/admin/jobs');
  revalidatePath('/admin/audit');
  return { ok: true as const };
}

/**
 * RFC 0008 §4.8 / PR-4 — admin manual retry：仅对 DEAD_LETTER 行有效；翻回 PENDING
 * 重置 attempt / lockedBy / lastError / completedAt / deleteAt，下一 tick 即可被
 * `FOR UPDATE SKIP LOCKED` 重新抢到。写 audit `job.retried`。
 *
 * 注意：admin 应在 retry 前修复根因；retry 仅是「再试一次」，不会自动绕过原失败原因。
 */
export async function retryJobAction(input: z.infer<typeof jobIdSchema>) {
  const me = await requireAdmin();
  const parsed = jobIdSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const result = await prisma.backgroundJob.updateMany({
    where: { id: parsed.data.jobId, status: 'DEAD_LETTER' },
    data: {
      status: 'PENDING',
      attempt: 0,
      lockedBy: null,
      lockedAt: null,
      lastError: null,
      completedAt: null,
      nextAttemptAt: new Date(),
      deleteAt: null,
    },
  });

  if (result.count === 0) {
    return { ok: false as const, error: 'not-found-or-not-dlq' as const };
  }

  logger.info({ actor: me.id, jobId: parsed.data.jobId }, 'admin-job-retried');
  await recordAudit({
    actorId: me.id,
    orgId: null,
    action: 'job.retried',
    target: parsed.data.jobId,
  });

  revalidatePath('/admin/jobs');
  revalidatePath('/admin/audit');
  return { ok: true as const };
}
