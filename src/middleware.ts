import NextAuth from 'next-auth';
import createIntlMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';

import { authConfig } from '@/lib/auth/config';
import { routing } from '@/i18n/routing';

const intlMiddleware = createIntlMiddleware(routing);
const { auth } = NextAuth(authConfig);

const PROTECTED = /^\/(?:[a-z]{2}\/)?(?:dashboard|settings|admin)(?:\/|$)/;
const ADMIN_ONLY = /^\/(?:[a-z]{2}\/)?admin(?:\/|$)/;
// RFC 0002 PR-2 — 仅允许 tfa-pending 用户到达的页面。
// PROTECTED 下的任何其他内容都会被反弹到 /login/2fa。
const TFA_CHALLENGE = /^\/(?:[a-z]{2}\/)?login\/2fa(?:\/|$)/;
// RFC 0002 PR-4 — PENDING_DELETION 用户允许到达的页面。
// 设置是唯一允许的目标地点，以便他们可以取消；PROTECTED 下的任何
// 其他内容都会被漏斗到 /settings。
const SETTINGS_BASE = /^\/(?:[a-z]{2}\/)?settings(?:\/|$)/;
// RFC 0005 — 不匹配的着陆页本身；不受重定向防护
// 以便我们不会在其上循环。
const REGION_MISMATCH = /^\/(?:[a-z]{2}\/)?region-mismatch(?:\/|$)/;

/**
 * RFC 0005 — 边缘运行时区域读取。
 *
 * 中间件不能导入 `currentRegion()`（仅 Node：它传递性地
 * 导入 pino + Prisma）。我们内联复制解析规则。
 * 与 `src/lib/region.ts` 保持同步。
 */
function deployRegion(): 'GLOBAL' | 'CN' | 'EU' {
  const raw = process.env.KITORA_REGION;
  if (raw === 'GLOBAL' || raw === 'CN' || raw === 'EU') return raw;
  const legacy = process.env.REGION;
  if (legacy === 'cn') return 'CN';
  if (legacy === 'global') return 'GLOBAL';
  return 'GLOBAL';
}

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const user = req.auth?.user;
  const isLoggedIn = !!user;
  const isProtected = PROTECTED.test(pathname);
  const isAdminOnly = ADMIN_ONLY.test(pathname);
  const isTfaChallenge = TFA_CHALLENGE.test(pathname);
  const isRegionMismatch = REGION_MISMATCH.test(pathname);
  const tfaPending = req.auth?.tfaPending === true;

  // RFC 0005 — 地区漂移守卫。在实践中应该永不触发，因为
  // 每个地区的堆栈都位于自己的域（kitora.io / kitora.cn /
  // kitora.eu）且 cookie 不跨域。我们仍然在服务器端进行双重检查：
  // 一个伪造的 cookie 携带 `userRegion: CN` 到 GLOBAL 堆栈
  // 否则将被接受。豁免列表很广（任何非 PROTECTED 路径），
  // 以便未认证的营销页面保持可达；一旦陈旧的跨区域会话尝试访问
  // dashboard / settings / admin 我们就反弹。
  const userRegion = req.auth?.userRegion;
  if (
    isLoggedIn &&
    isProtected &&
    !isRegionMismatch &&
    userRegion &&
    userRegion !== deployRegion()
  ) {
    const url = new URL('/region-mismatch', req.nextUrl);
    url.searchParams.set('expected', userRegion);
    return NextResponse.redirect(url);
  }

  if (isProtected && !isLoggedIn) {
    const loginUrl = new URL('/login', req.nextUrl);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // RFC 0002 PR-2 — 一个具有 `tfa_pending` 的已登录用户只能看到
  // 2FA 质询页面。PROTECTED 下的一切其他内容都被反弹到
  // /login/2fa，原始请求的路径被捕获用于验证后
  // 重定向。（我们让页面本身，而不仅仅是管理页面，把关这个，
  // 所以半认证的人也不能戳 /settings。）
  if (isLoggedIn && tfaPending && isProtected && !isTfaChallenge) {
    const url = new URL('/login/2fa', req.nextUrl);
    url.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(url);
  }

  // RFC 0002 PR-4 — 处于删除宽限期的账户只有一个
  // 允许的目标地点：/settings（取消横幅位于此处）。
  // 我们故意不对其余的进行 404——保持用户能够登录
  // 和转向是整个宽限期的要点。
  const userStatus = req.auth?.userStatus;
  const isSettings = SETTINGS_BASE.test(pathname);
  if (isLoggedIn && userStatus === 'PENDING_DELETION' && isProtected && !isSettings) {
    return NextResponse.redirect(new URL('/settings', req.nextUrl));
  }

  if (isAdminOnly && user?.role !== 'ADMIN') {
    return NextResponse.redirect(new URL('/dashboard', req.nextUrl));
  }

  return intlMiddleware(req as unknown as NextRequest);
});

export const config = {
  // 跳过 Next 内部、静态资产和 auth/Stripe webhook 路由
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
