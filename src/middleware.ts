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
 * 2FA 验证页面路由模式。
 * 登录后尚未完成 TOTP 验证的用户只能访问此页面，其他受保护路由均重定向到此处。
 */
const TFA_CHALLENGE = /^\/(?:[a-z]{2}\/)?login\/2fa(?:\/|$)/;

/**
 * 设置页面路由模式。
 * 账户处于待删除状态时，用户只能访问此页面（取消删除操作的入口）。
 */
const SETTINGS_BASE = /^\/(?:[a-z]{2}\/)?settings(?:\/|$)/;

/**
 * 区域不匹配提示页路由模式。
 * 已登录用户的归属区域与当前部署区域不一致时重定向到此页面。
 * 此页面本身不受保护，避免重定向死循环。
 */
const REGION_MISMATCH = /^\/(?:[a-z]{2}\/)?region-mismatch(?:\/|$)/;

/**
 * 读取当前部署区域。
 *
 * 中间件运行在 Edge 环境，无法直接使用 `currentRegion()`——
 * 该函数依赖 pino 和 Prisma，只能在 Node 环境中运行。
 * 因此改用零依赖的纯函数 `parseRegion()`，Node 与 Edge 共享同一份解析逻辑。
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
 * 每个请求按以下顺序依次检查，任意一步不通过则直接重定向：
 * 1. 区域一致性检查（已登录用户的归属区域与部署区域是否匹配）
 * 2. 登录状态检查（未登录用户禁止访问受保护路由）
 * 3. 2FA 验证状态检查（已登录但未完成 TOTP 验证的用户只能访问 2FA 页面）
 * 4. 账户删除状态检查（待删除账户只能访问设置页面）
 * 5. 管理员权限检查（非管理员禁止访问 /admin）
 * 6. 交由国际化中间件处理语言前缀与 URL 重写
 *
 * @param req 包含认证会话与 URL 信息的请求对象。
 * @returns 重定向响应，或经国际化处理后的请求。
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

  // 区域一致性检查。
  // 正常情况下不会触发——各区域部署在独立域名，cookie 不跨域。
  // 但作为防御措施，若用户的归属区域与当前部署区域不一致（例如 cookie 被带到了
  // 错误的域名下），则强制重定向到区域不匹配提示页。
  // 仅对受保护路由做此检查，营销页面等公开路由不受影响。
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

  // 2FA 验证状态检查。
  // 用户已登录但尚未完成 TOTP 验证时（tfaPending = true），
  // 只允许访问 /login/2fa，其余受保护路由一律重定向到该页面。
  // 页面层也有同样的检查，防止用户绕过中间件直接访问。
  if (isLoggedIn && tfaPending && isProtected && !isTfaChallenge) {
    // 重定向到 2FA 验证页面，保存原始路径用于验证后跳转
    const url = new URL('/login/2fa', req.nextUrl);
    url.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(url);
  }

  // 账户删除状态检查。
  // 已申请删除的账户（userStatus = 'PENDING_DELETION'）只允许访问 /settings，
  // 其余受保护路由一律重定向到该页面，让用户有机会取消删除操作。
  // 有意不返回 404——宽限期内用户必须能正常登录和导航。
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
