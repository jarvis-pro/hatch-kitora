import type { NextAuthConfig } from 'next-auth';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';

import { env } from '@/env';

/**
 * 边界安全的 Auth.js 配置。
 *
 * 由 `middleware.ts` 使用（在边界运行时运行）。它**不能**导入
 * Prisma 适配器或任何 Node 特定内容。完整配置 — 包含适配器
 * 和凭证提供商 — 存放在 `src/lib/auth/index.ts`。
 */
export const authConfig = {
  pages: {
    signIn: '/login',
    error: '/login',
  },
  providers: [
    ...(env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET
      ? [
          GitHub({
            clientId: env.AUTH_GITHUB_ID,
            clientSecret: env.AUTH_GITHUB_SECRET,
            allowDangerousEmailAccountLinking: true,
          }),
        ]
      : []),
    ...(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET
      ? [
          Google({
            clientId: env.AUTH_GOOGLE_ID,
            clientSecret: env.AUTH_GOOGLE_SECRET,
            allowDangerousEmailAccountLinking: true,
          }),
        ]
      : []),
  ],
  callbacks: {
    authorized({ auth, request }) {
      // 注意：此回调在此代码库中被绕过 — `src/middleware.ts`
      // 用自己的逻辑调用 `auth(callback)`，优先于 `authorized()`。
      // 重定向 / 角色 / tfa_pending 决策因此存放于那里。
      // 我们为直接 `auth()` 调用（RSC 边界帮助程序）保持此存根，
      // 其中相同规则仍适用。
      const isLoggedIn = !!auth?.user;
      const { pathname } = request.nextUrl;
      const isProtected = /^\/[^/]+\/(dashboard|settings|admin)/.test(pathname);
      const isAdminOnly = /^\/[^/]+\/admin/.test(pathname);

      if (isProtected && !isLoggedIn) {
        return false;
      }
      if (isAdminOnly && auth?.user?.role !== 'ADMIN') {
        return false;
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        const role = (user as { role?: 'USER' | 'ADMIN' }).role;
        token.role = role ?? 'USER';
        const sv = (user as { sessionVersion?: number }).sessionVersion;
        token.sessionVersion = typeof sv === 'number' ? sv : 0;
        // RFC 0002 PR-2 — 初始登录：如果用户启用了 2FA，将令牌标记为
        // pending，直到他们通过 /login/2fa。Node 端 jwt 回调也在每次
        // 调用时重新评估此项，使*刚启用*的 2FA 设置无法被现有 JWT 绕过。
        const tfa = (user as { twoFactorEnabled?: boolean }).twoFactorEnabled;
        if (tfa) {
          token.tfa_pending = true;
        }
        // RFC 0002 PR-4 — 登录时的账户生命周期状态。在每个后续 jwt()
        // 调用（Node 端）上重新验证，使不重新登录的状态变化仍生效。
        const status = (user as { status?: 'ACTIVE' | 'PENDING_DELETION' }).status;
        token.status = status ?? 'ACTIVE';
        // RFC 0005 — 用户行的区域。区域在创建后不可变，所以我们在
        // 登录时一次性播种。中间件（边界）从 JWT 读取此项以检测
        // 跨区域 cookie 走私。
        const region = (user as { region?: 'GLOBAL' | 'CN' | 'EU' }).region;
        if (region) token.region = region;
      }
      // `src/lib/auth/index.ts` 中的完整 Node 端配置覆盖此回调
      // 以另外验证 `token.sessionVersion` 对照数据库 —
      // 这里的边界安全版本无法查询 Prisma。
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.id as string) ?? session.user.id;
        session.user.role = (token.role as 'USER' | 'ADMIN' | undefined) ?? 'USER';
      }
      // RFC 0002 PR-1 — 传播 sidHash 使服务器操作 / RSC 可在
      // 活跃会话 UI 中标记"当前"设备会话。仅哈希离开 JWT；
      // 原始 sid 永不暴露。
      const sidHash = (token as { sidHash?: string }).sidHash;
      if (typeof sidHash === 'string' && sidHash.length > 0) {
        session.sidHash = sidHash;
      }
      // RFC 0002 PR-2 — 呈现 tfa_pending 使中间件 / RSC 可路由
      // 未验证的用户到 /login/2fa。
      if (token.tfa_pending === true) {
        session.tfaPending = true;
      }
      // RFC 0002 PR-4 — 呈现用户生命周期状态使中间件可
      // 路由 PENDING_DELETION 用户到取消删除屏幕。
      if (token.status === 'PENDING_DELETION') {
        session.userStatus = 'PENDING_DELETION';
      }
      // RFC 0005 — 呈现用户的区域使中间件（也是边界）
      // 可对照部署区域进行比较。跨区域 cookie 走私在
      // 不同域中不应该可能，但我们保持此作为服务器端
      // 保险检查。
      if (token.region === 'GLOBAL' || token.region === 'CN' || token.region === 'EU') {
        session.userRegion = token.region;
      }
      return session;
    },
  },
  session: { strategy: 'jwt' },
  secret: env.AUTH_SECRET,
} satisfies NextAuthConfig;
