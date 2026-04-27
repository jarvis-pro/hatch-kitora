// RFC 0007 PR-4 — POST /api/auth/webauthn/authenticate/options (anonymous)
//
// 登录页面上的无密码（"使用密钥登录"）流程的步骤 1。
// 不需要会话。返回 SDK 颁发的选项信封，带有 `allowCredentials: []`
// 所以浏览器弹出可发现的选择器 — 用户为此 RP ID 选择任何存储的密钥，
// 我们只在验证时了解用户。
//
// 质询持久化在 httpOnly Cookie 中（5 分钟 TTL）；
// 有关原理，请参见 `src/lib/webauthn/anonymous-challenge.ts`。

import { NextResponse } from 'next/server';

import { generateAuthenticationOptions } from '@simplewebauthn/server';

import { logger } from '@/lib/logger';
import { authLimiter } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/request';
import { setAnonymousChallenge } from '@/lib/webauthn/anonymous-challenge';
import { getRpId } from '@/lib/webauthn/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  // 匿名端点 — 按 IP 限制率。与密码登录表单相同的预算（RFC 0002 PR-1：authLimiter）。
  const ip = await getClientIp();
  const { success } = await authLimiter.limit(`webauthn-options:${ip}`);
  if (!success) {
    return NextResponse.json({ error: 'rate-limited' }, { status: 429 });
  }

  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    // 空的 allowCredentials → 可发现 / 无用户名流程。浏览器显示 OS / 密码管理器选择器；
    // 用户选择要使用哪个密钥，签名返回带有我们可以解码的 `userHandle`。
    allowCredentials: [],
    userVerification: 'preferred',
  });

  await setAnonymousChallenge(options.challenge);

  logger.info({ ip }, 'webauthn-passwordless-options-issued');
  return NextResponse.json(options);
}
