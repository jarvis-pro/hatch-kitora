'use server';

import { OrgRole } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { requireActiveOrg, requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

const orgScopeSchema = z.object({
  orgSlug: z.string().min(1).max(80),
});

/**
 * RFC 0002 PR-3 — data export server actions.
 *
 * Two entry points:
 *
 *   triggerUserExportAction()             — current user's own data
 *   triggerOrgExportAction({ orgSlug })   — entire org's data (OWNER only)
 *
 * Both insert a `DataExportJob` row in PENDING; the cron worker
 * (`scripts/run-export-jobs.ts`) picks it up and does the actual zip build.
 *
 * Rate limit: at most one *non-failed* export of the same scope key per
 * 24h. We enforce this in the DB rather than via Upstash so that the
 * limit survives Redis being unconfigured (worst case for the template).
 */

const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function triggerUserExportAction() {
  const me = await requireUser();

  const recent = await prisma.dataExportJob.findFirst({
    where: {
      userId: me.id,
      scope: 'USER',
      status: { in: ['PENDING', 'RUNNING', 'COMPLETED'] },
      createdAt: { gt: new Date(Date.now() - RATE_WINDOW_MS) },
    },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  if (recent) {
    return {
      ok: false as const,
      error: 'rate-limited' as const,
      retryAfter: new Date(recent.createdAt.getTime() + RATE_WINDOW_MS).toISOString(),
    };
  }

  const job = await prisma.dataExportJob.create({
    data: {
      userId: me.id,
      orgId: null,
      scope: 'USER',
      status: 'PENDING',
    },
    select: { id: true },
  });

  logger.info({ userId: me.id, jobId: job.id }, 'data-export-user-requested');
  await recordAudit({
    actorId: me.id,
    action: 'account.export_requested',
    target: job.id,
  });
  revalidatePath('/settings');
  return { ok: true as const, jobId: job.id };
}

export async function triggerOrgExportAction(input: z.infer<typeof orgScopeSchema>) {
  const me = await requireActiveOrg();
  const parsed = orgScopeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  // Resolve org by slug + verify caller is OWNER. We restrict by
  // membership instead of trusting the active-org cookie, so even if the
  // UI is on a different org the action only acts on the *requested* one
  // when the caller is its OWNER.
  const membership = await prisma.membership.findFirst({
    where: {
      userId: me.userId,
      organization: { slug: parsed.data.orgSlug },
      role: OrgRole.OWNER,
    },
    select: { orgId: true },
  });
  if (!membership) {
    return { ok: false as const, error: 'forbidden' as const };
  }

  const recent = await prisma.dataExportJob.findFirst({
    where: {
      orgId: membership.orgId,
      scope: 'ORG',
      status: { in: ['PENDING', 'RUNNING', 'COMPLETED'] },
      createdAt: { gt: new Date(Date.now() - RATE_WINDOW_MS) },
    },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  if (recent) {
    return {
      ok: false as const,
      error: 'rate-limited' as const,
      retryAfter: new Date(recent.createdAt.getTime() + RATE_WINDOW_MS).toISOString(),
    };
  }

  const job = await prisma.dataExportJob.create({
    data: {
      userId: me.userId,
      orgId: membership.orgId,
      scope: 'ORG',
      status: 'PENDING',
    },
    select: { id: true },
  });

  logger.info(
    { actor: me.userId, orgId: membership.orgId, jobId: job.id },
    'data-export-org-requested',
  );
  await recordAudit({
    actorId: me.userId,
    orgId: membership.orgId,
    action: 'org.export_requested',
    target: job.id,
  });
  revalidatePath('/settings');
  return { ok: true as const, jobId: job.id };
}
