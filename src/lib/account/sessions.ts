'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { revokeDeviceSessionById } from '@/lib/auth/device-session';
import { getCurrentSidHash, requireActiveOrg } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

const revokeSchema = z.object({
  id: z.string().min(1).max(64),
});

/**
 * RFC 0002 PR-1 — revoke a single device session.
 *
 * Refuses to revoke the caller's own session — that path is
 * `signOutEverywhereAction` (sign out + redirect). Refusing here keeps the
 * UX from accidentally killing the user mid-action.
 */
export async function revokeDeviceSessionAction(input: z.infer<typeof revokeSchema>) {
  const me = await requireActiveOrg();
  const parsed = revokeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const currentSidHash = await getCurrentSidHash();
  // Restrict by userId in the query so users can only ever see / touch
  // their own rows even if they craft an arbitrary id.
  const target = await prisma.deviceSession.findFirst({
    where: { id: parsed.data.id, userId: me.userId },
    select: { id: true, sidHash: true, revokedAt: true },
  });
  if (!target) {
    return { ok: false as const, error: 'not-found' as const };
  }
  if (target.revokedAt) {
    // Idempotent: already-revoked is a successful no-op so the UI can
    // optimistically remove the row without races.
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
