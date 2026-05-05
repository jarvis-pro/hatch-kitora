// RFC 0007 PR-4 — 匿名 WebAuthn 质询持久化（Cookie）。
//
// PR-3 质询助手（`src/lib/webauthn/challenge.ts`）使用 `userId` 作为键，
// 因为用户已经登录（在 2FA 质询期间）。PR-4 无密码流程还没有 userId——
// 浏览器将通过可发现的身份验证来显示凭据选择器，服务器仅在断言到达后
// 才知道哪个用户正在登录。
//
// 我们将质询持久化在一个 httpOnly cookie 中，范围是 /api/auth/，
// 生活时间为 5 分钟。Cookie 名称是常量（每个浏览器标签页只能进行一个
// 无密码流程），值是由 `@simplewebauthn` 生成的随机 32 字节质询。
// 验证路由在成功读取后会清除该 cookie。

import 'server-only';

import { cookies } from 'next/headers';

import { env } from '@/env';

const COOKIE_NAME = 'webauthn-passkey-challenge';
const TTL_SECONDS = 5 * 60;

export async function setAnonymousChallenge(challenge: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAME, challenge, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/api/auth/webauthn/authenticate',
    maxAge: TTL_SECONDS,
  });
}

/**
 * 读取并清除匿名质询 cookie。如果不存在 cookie，则返回 null。
 * 如果存在，总是会清除它——防御性的：攻击者不能在多个验证
 * 尝试中重放单个 cookie 值。
 */
export async function consumeAnonymousChallenge(): Promise<string | null> {
  const jar = await cookies();
  const value = jar.get(COOKIE_NAME)?.value;
  if (value) {
    jar.set(COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      path: '/api/auth/webauthn/authenticate',
      maxAge: 0,
    });
  }
  return value ?? null;
}
