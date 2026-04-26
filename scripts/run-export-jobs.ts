#!/usr/bin/env tsx
/**
 * RFC 0002 PR-3 — data export cron worker.
 *
 * Run from a Vercel / Fly cron every minute:
 *   pnpm tsx scripts/run-export-jobs.ts
 *
 * Three phases per invocation:
 *
 *   1. Recover stuck jobs — RUNNING > 15min ago → flip back to PENDING so
 *      a crashed previous worker doesn't strand a request indefinitely.
 *   2. Claim one PENDING row via optimistic `updateMany` and process it.
 *   3. Sweep — `expiresAt < now()` rows: delete the file, flip EXPIRED.
 *
 * The "claim one row at a time" pattern is intentional: every cron tick
 * processes at most one export, so a flood of concurrent requests gets
 * smoothed over many minutes. With expected volume (≤ 1 export / user /
 * 24h) this is plenty.
 */

import { logger } from '@/lib/logger';
import { prisma } from '@/lib/db';
import { sendDataExportReadyEmail } from '@/lib/auth/email-flows';
import { buildOrgExport, buildUserExport } from '@/lib/data-export/builder';
import { storage } from '@/lib/storage';

const STUCK_RUNNING_MS = 15 * 60 * 1000;
const DOWNLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function main() {
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
  // Pick the oldest PENDING row by createdAt. updateMany with the row's
  // unique id is the optimistic-claim lever — only one worker wins.
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
    // Another worker beat us; that's fine.
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

    // Notify the requestor by email so they can grab the link without
    // checking the UI. Fire-and-forget — failures are logged in the
    // sender, not thrown back.
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

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'run-export-jobs-fatal');
    process.exit(1);
  });
