// RFC 0007 PR-2 — PATCH / DELETE /api/auth/webauthn/credentials/:id
//
//   PATCH  — 重命名凭证（用户给定的标签）。
//   DELETE — 移除凭证。相同的事务重新计算 `twoFactorEnabled`，
//            所以移除最后一个密钥可能会将其翻转为 false。
//
// 两个都在凭证行的 `userId == requireUser().id` 上进行门控 —
// 用户只能管理他们自己的凭证。`:id` URL 参数是 DB 行的 cuid，
// 不是协议级别的 credentialId。

import { NextResponse } from 'next/server';

import { z } from 'zod';

import { recordAudit } from '@/services/audit';
import { requireUser } from '@/lib/auth/session';
import { recomputeTwoFactorEnabled } from '@/lib/auth/two-factor-state';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const renameSchema = z.object({ name: z.string().min(1).max(80) });

interface Params {
  params: Promise<{ id: string }>;
}

async function loadOwn(credentialDbId: string, userId: string) {
  return prisma.webAuthnCredential.findFirst({
    where: { id: credentialDbId, userId },
    select: { id: true, name: true },
  });
}

export async function PATCH(request: Request, { params }: Params) {
  const me = await requireUser().catch(() => null);
  if (!me) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const own = await loadOwn(id, me.id);
  if (!own) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const parsed = renameSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid-input' }, { status: 400 });
  }

  await prisma.webAuthnCredential.update({
    where: { id },
    data: { name: parsed.data.name },
  });

  await recordAudit({
    actorId: me.id,
    action: 'webauthn.credential_renamed',
    target: me.id,
    metadata: { credentialDbId: id, oldName: own.name, newName: parsed.data.name },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: Params) {
  const me = await requireUser().catch(() => null);
  if (!me) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const own = await loadOwn(id, me.id);
  if (!own) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.webAuthnCredential.delete({ where: { id } });
    await recomputeTwoFactorEnabled(me.id, tx);
  });

  await recordAudit({
    actorId: me.id,
    action: 'webauthn.credential_removed',
    target: me.id,
    metadata: { credentialDbId: id, name: own.name },
  });

  logger.info({ userId: me.id, credentialDbId: id }, 'webauthn-credential-removed');
  return NextResponse.json({ ok: true });
}
