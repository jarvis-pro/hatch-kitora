// 注意：这里刻意*不*设置 'server-only' — SSO 回调路由导入这个。
// 可传递 `next-auth/jwt` + `@/lib/db` 仅是 Node。
//
// SSO 路径的直接 Auth.js v5 会话铸造。绕过正常
// Credentials `authorize()` 流 — 我们已通过 Jackson 的 SAML 响应
// 验证了用户，所以 JWT 走出带外：
//
//   1. 铸造新鲜 `sid`（RFC 0002 PR-1）+ 持久化 `DeviceSession` 行。
//   2. 编码 Auth.js JWT 镜像 `jwt()` 回调将
//      产生的形状 — `id`、`role`、`sessionVersion`、`status`、`tfa_pending`、
//      `sid`、`sidHash`。
//   3. 戳 Auth.js 期望的会话 cookie 名称、名称 + 标志
//      根据 Auth.js v5 惯例从 `AUTH_URL` 协议自动派生。

import { encode } from 'next-auth/jwt';
import type { NextResponse } from 'next/server';

import { env } from '@/env';
import { createDeviceSession, generateSid, hashSid } from '@/lib/auth/device-session';
import { prisma } from '@/lib/db';

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 天 — 与 Auth.js 默认相同

interface IssueInput {
  userId: string;
  /** 可选的 UA / IP 从源请求捕获，用于 DeviceSession 行。 */
  userAgent?: string | null;
  ip?: string | null;
}

interface IssuedCookie {
  name: string;
  value: string;
  /** 匹配 Auth.js 自己的 cookie 标志，所以中间件解码器相同对待它。 */
  options: {
    httpOnly: true;
    sameSite: 'lax';
    secure: boolean;
    path: '/';
    maxAge: number;
  };
}

/**
 * 为 `userId` 铸造新鲜 Auth.js 会话并返回 cookie 形状
 * 以便调用者可以将其附加到 `NextResponse.redirect(...)`。
 *
 * 如果 `userId` 不再解析（竞争 vs 硬删除）返回 null — 调用者
 * 在这种情况下应重定向回 /login，使用 `sso_error=user-gone`。
 */
export async function issueSsoSession(input: IssueInput): Promise<IssuedCookie | null> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      id: true,
      role: true,
      sessionVersion: true,
      status: true,
    },
  });
  if (!user) return null;

  const rawSid = generateSid();
  await createDeviceSession({
    userId: user.id,
    rawSid,
    userAgent: input.userAgent ?? null,
    ip: input.ip ?? null,
  });

  // Auth.js v5 读取的 cookie 名称是环境相关的。生产环境
  //（HTTPS）使用 `__Secure-` 前缀；HTTP dev / e2e 使用普通名称。
  const secure = (env.AUTH_URL ?? env.NEXT_PUBLIC_APP_URL).startsWith('https://');
  const cookieName = secure ? '__Secure-authjs.session-token' : 'authjs.session-token';

  // Token 形状镜像 `src/lib/auth/index.ts` 的 `jwt()` 回调
  // 在登录时发出。保留字段名与该回调 +
  // `src/lib/auth/config.ts` 的 `session()` 回调同步，
  // 所以堆栈的其余部分读 SSO 会话完全如同读 Credentials 会话。
  const value = await encode({
    token: {
      sub: user.id,
      id: user.id,
      role: user.role,
      sessionVersion: user.sessionVersion,
      status: user.status,
      // SSO 绕过本地 2FA 挑战 — IdP 有其自己的 MFA。
      tfa_pending: false,
      sid: rawSid,
      sidHash: hashSid(rawSid),
    },
    secret: env.AUTH_SECRET,
    salt: cookieName,
    maxAge: SESSION_MAX_AGE,
  });

  return {
    name: cookieName,
    value,
    options: {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: SESSION_MAX_AGE,
    },
  };
}

/** 便利：将已发出的 cookie 附加到 `NextResponse`。 */
export function attachSsoSessionCookie(res: NextResponse, cookie: IssuedCookie): void {
  res.cookies.set(cookie.name, cookie.value, cookie.options);
}
