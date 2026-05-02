import NextAuth from 'next-auth';
import createIntlMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';

import { authConfig } from '@/lib/auth/config';
import { parseRegion } from '@/lib/region-parse';
import { routing } from '@/i18n/routing';

/**
 * next-intl 国际化中间件实例。
 * 根据 routing 配置自动处理区域检测和 URL 重写。
 */
const intlMiddleware = createIntlMiddleware(routing);

/**
 * Auth.js 中间件实例。
 * 基于 authConfig 处理会话验证和认证状态管理。
 */
const { auth } = NextAuth(authConfig);

/**
 * 受保护路由模式。
 * 匹配 /dashboard、/settings、/admin 及其子路由（考虑可选的区域前缀 /zh 等）。
 */
const PROTECTED = /^\/(?:[a-z]{2}\/)?(?:dashboard|settings|admin)(?:\/|$)/;

/**
 * 仅限管理员路由模式。
 * 匹配 /admin 及其子路由。
 */
const ADMIN_ONLY = /^\/(?:[a-z]{2}\/)?admin(?:\/|$)/;

/**
 * RFC 0002 PR-2 — 2FA 验证页面。
 * 仅允许等待 TOTP 验证的用户访问；PROTECTED 下的其他内容重定向到此页面。
 */
const TFA_CHALLENGE = /^\/(?:[a-z]{2}\/)?login\/2fa(?:\/|$)/;

/**
 * RFC 0002 PR-4 — 待删除账户允许访问的页面。
 * 仅允许 /settings（取消删除页面所在）；PROTECTED 下的其他内容重定向到此页面。
 */
const SETTINGS_BASE = /^\/(?:[a-z]{2}\/)?settings(?:\/|$)/;

/**
 * RFC 0005 — 区域不匹配着陆页。
 * 用户区域与部署区域不一致时的目标；本身不受重定向保护，避免循环。
 */
const REGION_MISMATCH = /^\/(?:[a-z]{2}\/)?region-mismatch(?:\/|$)/;

/**
 * RFC 0005 — 在边缘运行时读取部署区域。
 *
 * 中间件无法导入 `currentRegion()`（仅 Node 环境，会传递性导入 pino + Prisma），
 * 但解析规则统一封装在零依赖纯函数 `parseRegion()`（`src/lib/region-parse.ts`），
 * Node 入口与 Edge 入口共享同一份实现，避免双轨漂移。
 *
 * @returns 部署区域：'GLOBAL'、'CN' 或 'EU'。
 */
function deployRegion(): 'GLOBAL' | 'CN' | 'EU' {
  return parseRegion({
    KITORA_REGION: process.env.KITORA_REGION,
    REGION: process.env.REGION,
  });
}

/**
 * Next.js 主中间件处理程序。
 *
 * 基于 Auth.js 运行，按顺序执行以下检查：
 * 1. 区域一致性验证（RFC 0005）
 * 2. 受保护路由认证检查
 * 3. 2FA 状态验证（RFC 0002 PR-2）
 * 4. 待删除账户路由限制（RFC 0002 PR-4）
 * 5. 管理员权限检查
 * 6. 国际化路由处理
 *
 * @param req Next.js 请求对象，包含认证会话和 URL 信息。
 * @returns 可能的重定向响应或修改后的国际化请求。
 */
export default auth((req) => {
  const { pathname } = req.nextUrl;
  const user = req.auth?.user;
  // 检查用户是否已认证
  const isLoggedIn = !!user;
  // 检查当前路由是否受保护（需要认证）
  const isProtected = PROTECTED.test(pathname);
  // 检查是否为仅限管理员的路由
  const isAdminOnly = ADMIN_ONLY.test(pathname);
  // 检查是否为 2FA 验证页面
  const isTfaChallenge = TFA_CHALLENGE.test(pathname);
  // 检查是否为区域不匹配着陆页
  const isRegionMismatch = REGION_MISMATCH.test(pathname);
  // 检查是否处于 2FA 待验证状态
  const tfaPending = req.auth?.tfaPending === true;

  // RFC 0005 — 区域漂移检查。在理想情况下不应触发，因为各区域堆栈
  // 均位于独立域名（kitora.io / kitora.cn / kitora.eu）且 cookie 不跨域。
  // 但作为防御措施：若已认证用户的 userRegion 与部署区域不符（如 cookie
  // 被走私到其他堆栈），则强制重定向到区域不匹配页面。
  // 白名单宽松（非 PROTECTED 路由均放行），以保持营销页面可达；
  // 仅当进入 PROTECTED 路由时才触发检查。
  const userRegion = req.auth?.userRegion;
  if (
    isLoggedIn &&
    isProtected &&
    !isRegionMismatch &&
    userRegion &&
    userRegion !== deployRegion()
  ) {
    // 重定向到区域不匹配页面，传递期望的用户区域用于调试
    const url = new URL('/region-mismatch', req.nextUrl);
    url.searchParams.set('expected', userRegion);
    return NextResponse.redirect(url);
  }

  // 未认证用户访问受保护路由：重定向到登录，保存原始路径用于登录后跳转
  if (isProtected && !isLoggedIn) {
    const loginUrl = new URL('/login', req.nextUrl);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // RFC 0002 PR-2 — 2FA 待验证状态限制。
  // 如果用户已认证但尚未通过 TOTP 验证（tfaPending = true），
  // 则仅允许访问 /login/2fa 页面。其他 PROTECTED 路由统一重定向到 2FA 验证页面。
  // 注意：页面本身也有此检查，防止半认证用户绕过（如直接访问 /settings）。
  if (isLoggedIn && tfaPending && isProtected && !isTfaChallenge) {
    // 重定向到 2FA 验证页面，保存原始路径用于验证后跳转
    const url = new URL('/login/2fa', req.nextUrl);
    url.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(url);
  }

  // RFC 0002 PR-4 — 待删除账户路由限制。
  // 已安排删除的账户（userStatus = 'PENDING_DELETION'）仅允许访问 /settings
  // 页面（取消删除横幅所在地）。其他 PROTECTED 路由统一重定向到 /settings。
  // 我们故意不返回 404——保持用户能够登录和路由重定向是宽限期的核心机制。
  const userStatus = req.auth?.userStatus;
  const isSettings = SETTINGS_BASE.test(pathname);
  if (isLoggedIn && userStatus === 'PENDING_DELETION' && isProtected && !isSettings) {
    // 强制重定向到设置页面，用户可在此取消删除操作
    return NextResponse.redirect(new URL('/settings', req.nextUrl));
  }

  // 非管理员用户尝试访问管理员专属路由：重定向到仪表板
  if (isAdminOnly && user?.role !== 'ADMIN') {
    return NextResponse.redirect(new URL('/dashboard', req.nextUrl));
  }

  // 通过所有检查后，交由国际化中间件处理区域设置和 URL 重写
  return intlMiddleware(req as unknown as NextRequest);
});

/**
 * Next.js 中间件路由匹配配置。
 *
 * 定义哪些请求需要经过中间件处理。此处配置排除了：
 * - /api — 由 route handlers 直接处理
 * - /_next — Next.js 内部资源（编译输出、热重载等）
 * - /_vercel — Vercel 平台信息端点
 * - 含点的路径（*.jpg, *.css 等） — 静态资产
 */
export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
