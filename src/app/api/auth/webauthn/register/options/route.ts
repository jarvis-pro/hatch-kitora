// RFC 0007 PR-2 — POST /api/auth/webauthn/register/options
//
// 凭证注册的第 1 步。已认证的用户；返回浏览器将传递给
// `navigator.credentials.create()` 的 `PublicKeyCredentialCreationOptions` 信封。
// 副作用：将 SDK 生成的质询持久化到 `User.webauthnChallenge`
// 供 `register/verify` 交叉检查。
//
// `excludeCredentials` 列出用户现有的凭证，以便浏览器可以
// 去重 — 不需要两次 Touch ID 同一密钥。

import { NextResponse } from 'next/server';

import { generateRegistrationOptions } from '@simplewebauthn/server';

import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getRpId, getRpName } from '@/services/webauthn/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const me = await requireUser().catch(() => null);
  if (!me) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  // Auth.js 会话形状将 email/name 保留为 `string | null | undefined`。
  // 每个 Credentials / OAuth / SSO 用户都有电子邮件（适配器这样创建它），
  // 但类型系统看不到 — 在这里缩小范围，以便下面的 SDK 调用看到纯字符串。
  if (!me.email) {
    return NextResponse.json({ error: 'no-email-on-account' }, { status: 400 });
  }
  const userEmail = me.email;
  const userDisplayName = me.name ?? me.email;

  const existing = await prisma.webAuthnCredential.findMany({
    where: { userId: me.id },
    select: { credentialId: true, transports: true },
  });

  const options = await generateRegistrationOptions({
    rpName: getRpName(),
    rpID: getRpId(),
    // userID 是 WebAuthn 协议级别的用户句柄 — 认证器存储的不透明字节。
    // 使用我们的 cuid 字节；@simplewebauthn 接受 Uint8Array。
    userID: new TextEncoder().encode(me.id),
    userName: userEmail,
    userDisplayName,
    attestationType: 'none', // RFC 0007 §1 非目标：证明链
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports as never,
    })),
    authenticatorSelection: {
      // 'preferred' — 接受没有 UV 的硬件密钥，但在认证器支持时请求它
      // (RFC 0007 §9 决策)。
      userVerification: 'preferred',
      // 允许平台（Touch ID / Windows Hello）和跨平台（YubiKey）认证器。
      residentKey: 'preferred',
      requireResidentKey: false,
    },
  });

  // 持久化 SDK 颁发的质询供 `register/verify` 交叉检查。
  // `consumeChallenge`（RFC 0007 PR-1 库）将在验证成功或过期时读取 + 清除它。
  await prisma.user.update({
    where: { id: me.id },
    data: {
      webauthnChallenge: options.challenge,
      webauthnChallengeAt: new Date(),
    },
  });

  logger.info({ userId: me.id }, 'webauthn-register-options-issued');
  return NextResponse.json(options);
}
