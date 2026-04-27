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
 * RFC 0002 PR-3 — 数据导出服务器操作。
 *
 * 两个入口：
 *
 *   triggerUserExportAction()             — 当前用户自己的数据
 *   triggerOrgExportAction({ orgSlug })   — 整个组织的数据（仅 OWNER）
 *
 * 两者都会在数据库中插入一个 PENDING 状态的 `DataExportJob` 行；cron 工作程序
 * （`scripts/run-export-jobs.ts`）会后续接手并执行实际的 zip 构建。
 *
 * 速率限制：同一范围键在 24h 内最多一个*未失败*的导出。
 * 我们在数据库中强制执行此限制，而不是通过 Upstash，以便在 Redis 未配置时
 * 限制也能保留（模板的最坏情况）。
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

  // 通过 slug 解析 org + 验证调用者是否为 OWNER。我们通过成员身份而不是
  // 信任活跃 org cookie 来限制，所以即使 UI 在不同 org，该操作也仅在
  // 调用者是其 OWNER 时作用于*请求的* org。
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
