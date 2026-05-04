'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/services/audit';
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

/** 需要 ADMIN 会话 — 抛出异常（调用者永远不应该到达未授权）。 */
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

  // 防止管理员意外降级自己。
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
  // 平台级操作 — 参与者跨 org。orgId 保持 null，按照
  // RFC-0001 §4（"全局 / 平台管理操作允许 orgId = null"）。
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
 * RFC 0002 PR-2 — 平台管理员恢复路径，用于"我丢失了认证器
 * 且丢失了备份码"。在身份验证已通过外部途径验证后（支持工单），
 * 管理员在 `/admin/users/:id` 点击按钮，我们清除用户的 TwoFactorSecret +
 * 翻转 `twoFactorEnabled = false`。审计行将操作归因于管理员参与者
 * （target = 失去访问权限的用户）。电子邮件通知发往用户且 `byAdmin: true`
 * 以便他们下次读收件箱时知道发生了什么。
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

  // 同一 tx 清除：秘密行 + 去规范化标志一起移动，使部分失败无法将用户
  // 留在"twoFactorEnabled=true 但无秘密"的地狱中，他们永远无法登录。
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
 * RFC 0008 §4.8 / PR-4 — 管理员手动取消：将一行（DEAD_LETTER 或 PENDING）
 * 翻转为 CANCELED，写入审计 `job.cancelled`。RUNNING 行无法取消 — 等待当次结束。
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
 * RFC 0008 §4.8 / PR-4 — 管理员手动重试：仅对 DEAD_LETTER 行有效；翻转回 PENDING，
 * 重置 attempt / lockedBy / lastError / completedAt / deleteAt，下一 tick
 * 即可被 `FOR UPDATE SKIP LOCKED` 重新获取。写入审计 `job.retried`。
 *
 * 注意：管理员应在重试前修复根本原因；重试仅是"再试一次"，不会自动绕过原失败原因。
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
