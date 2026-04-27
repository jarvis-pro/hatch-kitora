// RFC 0007 PR-3 — /login/2fa Passkey 挑战的服务器操作。
//
// 与 `src/lib/account/two-factor.ts` 中的 `verifyTfaForCurrentSessionAction`（TOTP 路径）对称：
// 用户已经通过密码认证但 `tfa_pending = true`；通过 Passkey 挑战清空标志的方式与
// 正确的 TOTP 代码相同。
//
// 两个操作：
//
//   * getPasskeyChallengeAction() — 为当前用户生成 `PublicKeyCredentialRequestOptions`
//     （allowCredentials = 其存储的凭证）并持久化挑战。
//   * verifyPasskeyForCurrentSessionAction(response) — 验证断言对照存储的凭证，
//     提升计数器 / lastUsedAt，调用 updateAuthSession({ tfa: 'verified' }) 翻转 JWT，
//     并记录审计行。

'use server';

import { generateAuthenticationOptions } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { update as updateAuthSession } from '@/lib/auth';
import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { consumeChallenge } from '@/lib/webauthn/challenge';
import { getRpId } from '@/lib/webauthn/config';
import { verifyAuthentication } from '@/lib/webauthn/verify';

const verifySchema = z.object({
  /** 来自 `startAuthentication()` 的逐字 AuthenticationResponseJSON。 */
  response: z.unknown(),
});

/**
 * 2FA 挑战 passkey 仪式的第 1 步。
 *
 * 返回 SDK 发行的选项信封。副作用：
 *   * 在 `User.webauthnChallenge` 上持久化 `options.challenge` 以供验证
 *     交叉检查。
 *   * `allowCredentials` 过滤到用户的现有凭证，以便浏览器仅提示其中一个
 *     （而非任意可发现的密钥 — 那是 PR-4 无密码路径）。
 */
export async function getPasskeyChallengeAction() {
  const me = await requireUser().catch(() => null);
  if (!me) {
    return { ok: false as const, error: 'unauthorized' as const };
  }

  const credentials = await prisma.webAuthnCredential.findMany({
    where: { userId: me.id },
    select: { credentialId: true, transports: true },
  });
  if (credentials.length === 0) {
    return { ok: false as const, error: 'no-passkeys' as const };
  }

  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    allowCredentials: credentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports as never,
    })),
    userVerification: 'preferred',
  });

  await prisma.user.update({
    where: { id: me.id },
    data: {
      webauthnChallenge: options.challenge,
      webauthnChallengeAt: new Date(),
    },
  });

  return { ok: true as const, options };
}

/**
 * 2FA 挑战 passkey 仪式的第 2 步。
 *
 * 验证 SDK 断言对照存储的凭证，然后通过 `updateAuthSession({ tfa: 'verified' })`
 * 翻转 JWT 的 `tfa_pending` 为 false。与 TOTP 路径对称
 * （RFC 0002 PR-2 §verifyTfaForCurrentSessionAction）。
 */
export async function verifyPasskeyForCurrentSessionAction(input: z.infer<typeof verifySchema>) {
  const me = await requireUser().catch(() => null);
  if (!me) {
    return { ok: false as const, error: 'unauthorized' as const };
  }
  const parsed = verifySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const challenge = await consumeChallenge(me.id);
  if (!challenge) {
    return { ok: false as const, error: 'challenge-expired' as const };
  }

  // 断言的 `id` 字段是 credentialId — 查找它。
  const response = parsed.data.response as AuthenticationResponseJSON;
  if (typeof response?.id !== 'string') {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const credential = await prisma.webAuthnCredential.findFirst({
    where: { credentialId: response.id, userId: me.id },
    select: {
      id: true,
      credentialId: true,
      publicKey: true,
      counter: true,
      transports: true,
    },
  });
  if (!credential) {
    logger.warn({ userId: me.id }, 'webauthn-tfa-credential-not-found');
    return { ok: false as const, error: 'unknown-credential' as const };
  }

  const verified = await verifyAuthentication({
    response,
    expectedChallenge: challenge,
    credential: {
      id: credential.credentialId,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports,
    },
  });
  if (!verified) {
    logger.warn({ userId: me.id, credId: credential.id }, 'webauthn-tfa-verify-failed');
    return { ok: false as const, error: 'verification-failed' as const };
  }

  await prisma.webAuthnCredential.update({
    where: { id: credential.id },
    data: { counter: verified.newCounter, lastUsedAt: new Date() },
  });

  // 镜像 TOTP 成功路径：翻转 JWT 的 tfa_pending 标志。
  await updateAuthSession({ tfa: 'verified' } as unknown as Parameters<
    typeof updateAuthSession
  >[0]).catch(() => {});

  await recordAudit({
    actorId: me.id,
    action: 'webauthn.tfa_succeeded',
    target: me.id,
    metadata: { credentialDbId: credential.id },
  });

  return { ok: true as const };
}
