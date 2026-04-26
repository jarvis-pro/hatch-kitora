// RFC 0007 PR-2 — PATCH / DELETE /api/auth/webauthn/credentials/:id
//
//   PATCH  — rename a credential (user-given label).
//   DELETE — remove a credential. Same tx recomputes `twoFactorEnabled`
//            so removing the last passkey may flip it false.
//
// Both gated on the credential row's `userId == requireUser().id` —
// users can only manage their own credentials. The `:id` URL parameter
// is the DB row's cuid, NOT the protocol-level credentialId.

import { NextResponse } from 'next/server';

import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
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
