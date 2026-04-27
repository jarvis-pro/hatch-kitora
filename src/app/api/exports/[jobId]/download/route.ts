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
 * DataExportJob 行和存储提供商之间的授权门控握手。
 * 要强制执行的三个规则：
 *
 *   1. 调用者必须经过身份验证（Cookie 会话）。
 *   2. 调用者必须拥有该工作：
 *        - USER 范围 → 行的 userId 匹配。
 *        - ORG 范围  → 调用者是该行 orgId 的当前 OWNER。
 *   3. 工作必须是 COMPLETED，尚未过期，并具有 storagePath。
 *
 * 本地提供商流式传输文件；S3 提供商通过 302 返回签名 URL。
 * 提供商抽象返回 `kind: 'stream' | 'redirect'` 以便此路由保持存储无关。
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

  // 所有权检查。
  if (job.scope === 'USER') {
    if (job.userId !== userId) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
  } else {
    if (!job.orgId) {
      // ORG 范围的行没有 orgId — 损坏；拒绝而不是猜测。
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

  const resolved = await storage.resolveDownload(job.storagePath, 60 /* 秒 */);
  if (resolved.kind === 'redirect') {
    return NextResponse.redirect(resolved.url, 302);
  }

  // 本地流路径。通过提供商的完整路径助手读取文件，
  // 以便消毒规则位于一个地方。
  if (!(storage instanceof LocalFsProvider)) {
    // 提供商返回 'stream' 但它不是 LocalFsProvider — 应该是
    // 无法到达；失败大声所以我们在日志中注意到。
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
