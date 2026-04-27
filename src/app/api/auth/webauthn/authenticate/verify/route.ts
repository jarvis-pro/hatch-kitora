// RFC 0007 PR-4 — POST /api/auth/webauthn/authenticate/verify (anonymous)
//
// 登录页面上无密码流程的步骤 2。接收 `startAuthentication()` 的逐字 `AuthenticationResponseJSON`，
// 通过其协议级别的 `id` 在我们的 DB 中查找凭证，验证签名，
// 并通过 `issueSsoSession` 铸造新鲜的 Auth.js 会话（RFC 0004 SSO 使用的相同 JWT 直接编码形状）。
//
// 成功时，响应设置会话 Cookie + 使用 `redirectTo` 字段响应；
// 客户端导航浏览器。我们刻意不 302 — SDK fetch 是 XHR 风格，
// 重定向只会被 fetch 无声地跟随。
//
// 按 IP 限制率（authLimiter）。失败模式（缺少质询、未知凭证、错误签名）
// 都返回 401 和通用错误代码，以便攻击者无法映射 credentialId 空间。

import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { attachSsoSessionCookie, issueSsoSession } from '@/lib/sso/issue-session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { authLimiter } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/request';
import { consumeAnonymousChallenge } from '@/lib/webauthn/anonymous-challenge';
import { verifyAuthentication } from '@/lib/webauthn/verify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const inputSchema = z.object({
  /** `startAuthentication()` 的逐字 AuthenticationResponseJSON。 */
  response: z.unknown(),
  /** 可选的回调 URL — 传递给重定向。 */
  callbackUrl: z.string().optional(),
});

export async function POST(request: Request) {
  const ip = await getClientIp();
  const { success } = await authLimiter.limit(`webauthn-verify:${ip}`);
  if (!success) {
    return NextResponse.json({ error: 'rate-limited' }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid-input' }, { status: 400 });
  }

  const challenge = await consumeAnonymousChallenge();
  if (!challenge) {
    return NextResponse.json({ error: 'challenge-expired' }, { status: 400 });
  }

  const response = parsed.data.response as AuthenticationResponseJSON;
  if (typeof response?.id !== 'string') {
    return NextResponse.json({ error: 'invalid-input' }, { status: 400 });
  }

  // 反向查询：credentialId 是我们在注册时存储的。
  // PENDING_DELETION 用户仍可通过密码登录（RFC 0002 PR-4 — 取消删除）；
  // 在相同基础上允许 Passkey。v1 不需要进一步的状态门。
  const credential = await prisma.webAuthnCredential.findUnique({
    where: { credentialId: response.id },
    select: {
      id: true,
      userId: true,
      credentialId: true,
      publicKey: true,
      counter: true,
      transports: true,
    },
  });
  if (!credential) {
    logger.warn({ ip }, 'webauthn-passwordless-credential-not-found');
    return NextResponse.json({ error: 'verification-failed' }, { status: 401 });
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
    logger.warn(
      { ip, userId: credential.userId, credId: credential.id },
      'webauthn-passwordless-verify-failed',
    );
    return NextResponse.json({ error: 'verification-failed' }, { status: 401 });
  }

  // 提升凭证状态。
  await prisma.webAuthnCredential.update({
    where: { id: credential.id },
    data: { counter: verified.newCounter, lastUsedAt: new Date() },
  });

  // 铸造新鲜 JWT + DeviceSession 行 + Cookie。RFC 0004 用于 SSO 绕过的相同模式 —
  // 结果会话形状（sub / id / role / sessionVersion / status / tfa_pending: false / sid / sidHash）
  // 与密码+TOTP 会话无法区分，所以中间件 / RSC 不需要区分。
  const headersList = await headers();
  const userAgent = headersList.get('user-agent') ?? null;
  const cookie = await issueSsoSession({
    userId: credential.userId,
    userAgent,
    ip,
  });
  if (!cookie) {
    return NextResponse.json({ error: 'verification-failed' }, { status: 401 });
  }

  await recordAudit({
    actorId: credential.userId,
    action: 'webauthn.login_succeeded',
    target: credential.userId,
    metadata: { credentialDbId: credential.id },
  });

  const callback = parsed.data.callbackUrl?.startsWith('/')
    ? parsed.data.callbackUrl
    : '/dashboard';

  const res = NextResponse.json({ ok: true, redirectTo: callback });
  attachSsoSessionCookie(res, cookie);
  return res;
}
