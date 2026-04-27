// 注意：这里故意*没有* `'server-only'` — RFC 0008 PR-2 将此
// `runExportJobsTick()` 包装到 `export.tick` 后台工作，
// 可从 Fly / Aliyun ACK 上的 `scripts/run-jobs.ts` (tsx CLI)
// 或 `/api/jobs/tick` Vercel Cron 路由驱动。
// 传递的 `@/lib/db` (prisma) + `@/env` 依赖项仍然限制意外的客户端打包。
//
// 数据导出扫描的库形式。从 `scripts/run-export-jobs.ts` 未改变迁移 —
// RFC 0008 §4.6 / §2「借坡下驴, 不重写历史」：
// 导出域状态机（PENDING → RUNNING → COMPLETED / FAILED / EXPIRED）
// 被逐字保留；此文件仅重新定位逻辑，以便新的 `export.tick`
// 包装工作可以调用它。

import { logger } from '@/lib/logger';
import { prisma } from '@/lib/db';
import { sendDataExportReadyEmail } from '@/lib/auth/email-flows';
import { buildOrgExport, buildUserExport } from '@/lib/data-export/builder';
import { storage } from '@/lib/storage';

const STUCK_RUNNING_MS = 15 * 60 * 1000;
const DOWNLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * RFC 0002 PR-3 / RFC 0008 PR-2 — 数据导出 cron 滴答。
 *
 * 每次调用的三个阶段：
 *
 *   1. 恢复卡住的工作 — RUNNING > 15 分钟前 → 翻转回 PENDING，
 *      以便崩溃的前一个工作者不会无限期地搁置请求。
 *   2. 通过乐观的 `updateMany` 声明一行 PENDING 并处理它。
 *   3. 扫描 — `expiresAt < now()` 行：删除文件，翻转为 EXPIRED。
 *
 * "一次声明一行"模式是有意的：每个 cron 滴答最多处理一个导出，
 * 所以并发请求的洪泛在许多分钟内得到平滑处理。
 * 对于预期的量（≤ 1 导出 / 用户 / 24h），这已足够。
 */
export async function runExportJobsTick(): Promise<void> {
  await recoverStuckJobs();
  await claimAndRun();
  await sweepExpired();
}

async function recoverStuckJobs() {
  const cutoff = new Date(Date.now() - STUCK_RUNNING_MS);
  const result = await prisma.dataExportJob.updateMany({
    where: { status: 'RUNNING', startedAt: { lt: cutoff } },
    data: { status: 'PENDING', startedAt: null },
  });
  if (result.count > 0) {
    logger.warn({ count: result.count }, 'data-export-stuck-jobs-recovered');
  }
}

async function claimAndRun() {
  // 按 createdAt 选择最旧的 PENDING 行。使用行的唯一 id
  // 进行 updateMany 是乐观声明杠杆 — 只有一个工作者赢。
  const candidate = await prisma.dataExportJob.findFirst({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!candidate) return;

  const claim = await prisma.dataExportJob.updateMany({
    where: { id: candidate.id, status: 'PENDING' },
    data: { status: 'RUNNING', startedAt: new Date() },
  });
  if (claim.count === 0) {
    // 另一个工作者领先我们；没关系。
    return;
  }

  const job = await prisma.dataExportJob.findUniqueOrThrow({
    where: { id: candidate.id },
    select: { id: true, userId: true, orgId: true, scope: true },
  });

  try {
    const built =
      job.scope === 'ORG' ? await buildOrgExport(job.orgId!) : await buildUserExport(job.userId);

    const stored = await storage.put({
      suggestedKey: built.filename,
      body: built.body,
      contentType: 'application/zip',
    });

    const expiresAt = new Date(Date.now() + DOWNLOAD_TTL_MS);
    await prisma.dataExportJob.update({
      where: { id: job.id },
      data: {
        status: 'COMPLETED',
        storagePath: stored.key,
        sizeBytes: stored.sizeBytes,
        expiresAt,
        completedAt: new Date(),
      },
    });

    // 通过电子邮件通知请求者，以便他们可以在不检查 UI 的情况下
    // 获取链接。异步发送 — 失败在发送者中记录，不被抛回。
    const actor = await prisma.user.findUnique({
      where: { id: job.userId },
      select: { email: true, name: true },
    });
    if (actor?.email) {
      void sendDataExportReadyEmail(
        {
          id: job.userId,
          email: actor.email,
          name: actor.name,
        },
        { jobId: job.id, scope: job.scope },
      );
    }

    logger.info(
      { jobId: job.id, userId: job.userId, sizeBytes: stored.sizeBytes },
      'data-export-completed',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    logger.error({ err, jobId: job.id }, 'data-export-failed');
    await prisma.dataExportJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        errorMessage: message.slice(0, 500),
        completedAt: new Date(),
      },
    });
  }
}

async function sweepExpired() {
  const now = new Date();
  const expired = await prisma.dataExportJob.findMany({
    where: {
      status: 'COMPLETED',
      expiresAt: { lt: now },
      storagePath: { not: null },
    },
    select: { id: true, storagePath: true },
    take: 100,
  });
  for (const row of expired) {
    if (row.storagePath) {
      await storage.delete(row.storagePath).catch((err) => {
        logger.warn({ err, jobId: row.id }, 'data-export-delete-failed');
      });
    }
    await prisma.dataExportJob.update({
      where: { id: row.id },
      data: { status: 'EXPIRED', storagePath: null },
    });
  }
}
