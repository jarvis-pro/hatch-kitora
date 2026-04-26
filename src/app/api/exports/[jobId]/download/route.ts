import { readFile } from 'node:fs/promises';

import { OrgRole } from '@prisma/client';
import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { LocalFsProvider } from '@/lib/storage/local-fs';
import { storage } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0002 PR-3 — `GET /api/exports/[jobId]/download`
 *
 * Auth-gated handoff between the DataExportJob row and the storage
 * provider. Three rules to enforce:
 *
 *   1. Caller must be authenticated (cookie session).
 *   2. Caller must own the job:
 *        - USER scope → the row's userId matches.
 *        - ORG scope  → caller is a current OWNER of the row's orgId.
 *   3. Job must be COMPLETED, not yet expired, and have a storagePath.
 *
 * Local provider streams the file; S3 provider returns a signed URL via
 * 302. The provider abstraction returns `kind: 'stream' | 'redirect'`
 * so this route stays storage-agnostic.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { jobId } = await params;
  const job = await prisma.dataExportJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      userId: true,
      orgId: true,
      scope: true,
      status: true,
      storagePath: true,
      expiresAt: true,
    },
  });
  if (!job) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  // Ownership check.
  if (job.scope === 'USER') {
    if (job.userId !== userId) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
  } else {
    if (!job.orgId) {
      // ORG-scoped row without orgId — corrupt; refuse rather than guess.
      return NextResponse.json({ error: 'invalid-job' }, { status: 500 });
    }
    const owner = await prisma.membership.findFirst({
      where: { userId, orgId: job.orgId, role: OrgRole.OWNER },
      select: { id: true },
    });
    if (!owner) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
  }

  if (job.status !== 'COMPLETED' || !job.storagePath) {
    return NextResponse.json({ error: 'not-ready', status: job.status }, { status: 409 });
  }
  if (job.expiresAt && job.expiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: 'expired' }, { status: 410 });
  }

  const resolved = await storage.resolveDownload(job.storagePath, 60 /* seconds */);
  if (resolved.kind === 'redirect') {
    return NextResponse.redirect(resolved.url, 302);
  }

  // Local stream path. Read the file via the provider's full-path helper
  // so the sanitisation rules live in one place.
  if (!(storage instanceof LocalFsProvider)) {
    // Provider returned 'stream' but it isn't LocalFsProvider — should be
    // unreachable; fail loudly so we notice in logs.
    return NextResponse.json({ error: 'storage-misconfigured' }, { status: 500 });
  }
  try {
    const fullPath = storage.fullPath(job.storagePath);
    const body = await readFile(fullPath);
    const filename = job.storagePath.split('/').pop() ?? 'export.zip';
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(body.length),
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    logger.error({ err, jobId }, 'data-export-download-stream-failed');
    return NextResponse.json({ error: 'read-failed' }, { status: 500 });
  }
}
