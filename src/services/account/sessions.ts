'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/services/audit';
import { revokeDeviceSessionById } from '@/lib/auth/device-session';
import { getCurrentSidHash, requireActiveOrg } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

const revokeSchema = z.object({
  id: z.string().min(1).max(64),
});

/**
 * RFC 0002 PR-1 — 吊销单个设备会话。
 *
 * 拒绝吊销调用者自己的会话 — 该路径是 `signOutEverywhereAction`（登出 + 重定向）。
 * 拒绝这里可防止 UI 在用户操作中途意外杀死会话。
 */
export async function revokeDeviceSessionAction(input: z.infer<typeof revokeSchema>) {
  const me = await requireActiveOrg();
  const parsed = revokeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const currentSidHash = await getCurrentSidHash();
  // 在查询中按 userId 限制，使用户即使手工提供任意 id 也只能看到/触及自己的行。
  const target = await prisma.deviceSession.findFirst({
    where: { id: parsed.data.id, userId: me.userId },
    select: { id: true, sidHash: true, revokedAt: true },
  });
  if (!target) {
    return { ok: false as const, error: 'not-found' as const };
  }
  if (target.revokedAt) {
    // 幂等：已吊销是成功的空操作，UI 可乐观地删除行而无竞态。
    return { ok: true as const };
  }
  if (currentSidHash && target.sidHash === currentSidHash) {
    return { ok: false as const, error: 'cannot-revoke-current' as const };
  }

  const ok = await revokeDeviceSessionById(me.userId, target.id);
  if (!ok) {
    return { ok: false as const, error: 'not-found' as const };
  }

  logger.info({ userId: me.userId, sessionId: target.id }, 'device-session-revoked');
  await recordAudit({
    actorId: me.userId,
    orgId: me.orgId,
    action: 'session.revoked',
    target: target.id,
  });

  revalidatePath('/settings');
  return { ok: true as const };
}
