// RFC 0007 PR-2 — POST /api/auth/webauthn/register/verify
//
// 凭证注册的步骤 2。接收来自 `navigator.credentials.create()` 的 `RegistrationResponseJSON`，
// 验证对步骤 1 中铸造的质询的签名，并持久化新的 `WebAuthnCredential` 行。
// 相同的事务重新计算 `User.twoFactorEnabled`，以便向先前无 2FA 的账户添加密钥
// 一次性地翻转标志。

import { NextResponse } from 'next/server';

import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { requireUser } from '@/lib/auth/session';
import { recomputeTwoFactorEnabled } from '@/lib/auth/two-factor-state';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { consumeChallenge } from '@/lib/webauthn/challenge';
import { verifyRegistration } from '@/lib/webauthn/verify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const inputSchema = z.object({
  /**
   * `@simplewebauthn/browser` 的 `startRegistration()` 返回的逐字 `RegistrationResponseJSON`。
   * 我们不在这里进行形状检查内部字段 — SDK 的验证助手进行检查。
   */
  response: z.unknown(),
  /** 用户给定的凭证标签，例如 "MacBook Touch ID"。 */
  name: z.string().min(1).max(80),
});

export async function POST(request: Request) {
  const me = await requireUser().catch(() => null);
  if (!me) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid-input' }, { status: 400 });
  }

  const challenge = await consumeChallenge(me.id);
  if (!challenge) {
    return NextResponse.json({ error: 'challenge-expired' }, { status: 400 });
  }

  const verified = await verifyRegistration({
    response: parsed.data.response as RegistrationResponseJSON,
    expectedChallenge: challenge,
  });
  if (!verified) {
    return NextResponse.json({ error: 'verification-failed' }, { status: 400 });
  }

  // 单个事务：插入凭证行 + 重新计算 twoFactorEnabled。
  const credential = await prisma.$transaction(async (tx) => {
    const created = await tx.webAuthnCredential.create({
      data: {
        userId: me.id,
        credentialId: verified.credentialId,
        publicKey: verified.publicKey,
        counter: verified.counter,
        transports: verified.transports,
        deviceType: verified.deviceType,
        backedUp: verified.backedUp,
        name: parsed.data.name,
      },
      select: { id: true, credentialId: true, deviceType: true },
    });

    await recomputeTwoFactorEnabled(me.id, tx);
    return created;
  });

  await recordAudit({
    actorId: me.id,
    action: 'webauthn.credential_added',
    target: me.id,
    metadata: {
      credentialDbId: credential.id,
      deviceType: credential.deviceType,
      name: parsed.data.name,
    },
  });

  logger.info(
    { userId: me.id, credentialDbId: credential.id, deviceType: credential.deviceType },
    'webauthn-register-success',
  );

  return NextResponse.json({ id: credential.id, ok: true });
}
