// 注意：故意**不是** `'server-only'` — RFC 0008 PR-2 将其包装到 `deletion.tick`
// 后台任务中，可从 Fly / Aliyun ACK 上的 `scripts/run-jobs.ts`（tsx CLI）
// 或从 Vercel Cron 路由 `/api/jobs/tick` 驱动。传递性 `@/lib/db` + `@/env`
// 依赖仍然防守意外的客户端捆绑。
//
// 日常删除 cron 的库形式。从 `scripts/run-deletion-cron.ts` 未改变迁移 —
// RFC 0008 §4.6 / §2「借坡下驴, 不重写历史」：用户 PENDING_DELETION → hard-delete
// 状态机逐字保留；此文件仅重定位逻辑使新的 `deletion.tick` 包装任务可调用它。

import { OrgRole } from '@prisma/client';

import { logger } from '@/lib/logger';
import { prisma } from '@/lib/db';
import { recordAudit } from '@/services/audit';

/**
 * RFC 0002 PR-4 / RFC 0008 PR-2 — 日常删除 cron tick。
 *
 * 不变量：用户被硬删除当且仅当
 *   `status = PENDING_DELETION` AND `deletionScheduledAt < now()`。
 *
 * 每次删除前的防守性双重检查：
 *   - 用户不得是非 personal 多成员 org 的 OWNER。调度操作在请求时强制执行此检查，
 *     但宽限期为 30 天 — 足以出现"有人重新将我添加为 OWNER"的边界情况。
 *     如果触发，记录错误并跳过；ops 将手动解决。
 *
 * 审计 + 电子邮件副作用：
 *   - `account.deleted` 审计行在删除前写入（actorId = null 以便
 *     在级联中幸存）。
 *   - 不向用户发送电子邮件；我们已发送"已调度"并且用户有 30 天。
 *     发送"你现在被删除"是尴尬的 UX，而且没有人可以对其采取行动。
 */
export async function runDeletionCronTick(): Promise<void> {
  const now = new Date();
  const due = await prisma.user.findMany({
    where: {
      status: 'PENDING_DELETION',
      deletionScheduledAt: { lt: now },
    },
    select: {
      id: true,
      email: true,
      memberships: {
        select: {
          role: true,
          organization: { select: { id: true, slug: true } },
        },
      },
    },
    take: 200, // 软批处理上限；cron 每天运行所以有充足的空间。
  });

  if (due.length === 0) {
    logger.info('deletion-cron-no-due-rows');
    return;
  }
  logger.info({ count: due.length }, 'deletion-cron-batch');

  for (const user of due) {
    try {
      // 防守：如果用户是任何*非 personal*多成员 org 的 OWNER，拒绝硬删除。
      // 调度器也会阻止这种情况，但 30 天窗口足以导致状态漂移。
      const blockingOrgIds = user.memberships
        .filter((m) => m.role === OrgRole.OWNER && !m.organization.slug.startsWith('personal-'))
        .map((m) => m.organization.id);
      if (blockingOrgIds.length > 0) {
        logger.error(
          { userId: user.id, orgIds: blockingOrgIds },
          'deletion-cron-skipped-owner-of-orgs',
        );
        continue;
      }

      // 在删除前记录审计，以便行的引用可解析。
      // AuditLog 在 actorId 上没有 FK，所以清空是可以的。
      await recordAudit({
        actorId: null,
        action: 'account.deleted',
        target: user.id,
        metadata: { email: user.email ?? null, by: 'cron' },
      });

      // 删除用户拥有的 personal org。
      // 否则级联的 Membership 会留下"personal-xxxx"org 且零成员。
      const personalOrgIds = user.memberships
        .filter((m) => m.organization.slug.startsWith('personal-'))
        .map((m) => m.organization.id);

      await prisma.$transaction([
        ...personalOrgIds.map((id) => prisma.organization.delete({ where: { id } })),
        prisma.user.delete({ where: { id: user.id } }),
      ]);

      logger.info(
        { userId: user.id, personalOrgIds, count: personalOrgIds.length },
        'deletion-cron-account-deleted',
      );
    } catch (err) {
      logger.error({ err, userId: user.id }, 'deletion-cron-row-failed');
    }
  }
}
