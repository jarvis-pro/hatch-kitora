'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

const setRoleSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(['USER', 'ADMIN']),
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
