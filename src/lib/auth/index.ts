import { PrismaAdapter } from '@auth/prisma-adapter';
import { OrgRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { headers } from 'next/headers';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { currentRegion } from '@/lib/region';

import { authConfig } from './config';
import { createDeviceSession, generateSid, hashSid, validateDeviceSession } from './device-session';

// RFC 0004 PR-2 — 通过 Auth.js 的 `CredentialsSignin.code` 浮出，
// 所以 `loginAction` 服务器操作可以将其映射到 UI 的
// "your org requires SSO" rail 的 `sso-required` 原因。
class SsoRequiredError extends CredentialsSignin {
  code = 'sso_required';
}

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

/**
 * RFC 0005 — 区域感知 Prisma 适配器。
 *
 * 标准的 `@auth/prisma-adapter` 为 OAuth 账户链接查找发出
 * `findUnique({ where: { email } })`，并为 `prisma.user.create({ data })`
 * 不带区域。两者都在新的 `(email, region)` 复合下破裂：
 * 查找不再编译，创建无声地写入列的 `GLOBAL` 默认值 —
 * CN/EU 堆栈上错误。
 *
 * 我们委托给标准适配器，只覆盖两个受影响的方法，
 * 所以未来的 Auth.js 功能乘坐上游行为。
 */
function regionAwarePrismaAdapter() {
  const base = PrismaAdapter(prisma);
  return {
    ...base,
    async getUserByEmail(email: string) {
      return prisma.user.findUnique({
        where: { email_region: { email, region: currentRegion() } },
      });
    },
    async createUser(data: Parameters<NonNullable<typeof base.createUser>>[0]) {
      // 标准适配器的行为：删除任何传入的 id，让 Prisma
      // 铸造一个。我们通过解构重用 `stripUndefined` 的精神。
      // RFC 0005 — 为部署区域加盖印章，所以 OAuth 创建的用户
      // 落在正确的 `(email, region)` 槽中。
      const { id: _id, ...rest } = data;
      void _id;
      return prisma.user.create({
        data: { ...rest, region: currentRegion() },
      });
    },
  };
}

export const {
  handlers,
  auth,
  signIn,
  signOut,
  unstable_update: update,
} = NextAuth({
  ...authConfig,
  adapter: regionAwarePrismaAdapter(),
  // 将 Auth.js 噪声路由通过 pino，级别合理。错误的密码是
  // 用户错误，不是应用错误 — 保持在调试级别，
  // 所以生产日志不会在每次登录失败时爆炸。
  logger: {
    error(error) {
      const name = (error as { name?: string }).name ?? error.constructor.name;
      if (name === 'CredentialsSignin') {
        logger.debug({ err: error }, 'auth-credentials-rejected');
        return;
      }
      logger.error({ err: error }, 'auth-error');
    },
    warn(code) {
      logger.warn({ code }, 'auth-warning');
    },
    debug(message, metadata) {
      logger.debug({ metadata }, message);
    },
  },
  providers: [
    ...authConfig.providers,
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const parsed = credentialsSchema.safeParse(credentials);
        if (!parsed.success) {
          return null;
        }

        const { email, password } = parsed.data;
        // RFC 0005 — 凭证登录是区域限定的。同一地址
        // 可能在不同的区域中作为独立账户存在；
        // 该过程只为其自己的区域提供服务，
        // 所以从这里无法颁发堆栈泄漏会话。
        const user = await prisma.user.findUnique({
          where: { email_region: { email, region: currentRegion() } },
        });
        if (!user?.passwordHash) {
          return null;
        }

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
          logger.warn({ email }, 'invalid-credentials');
          return null;
        }

        // RFC 0004 PR-2 — 强制 SSO。如果此用户属于任何已
        // 翻转 `enforceForLogin = true` 的组织，且该 IdP
        // 是 `enabledAt` 活跃的，密码路径被关闭。这类组织的
        // OWNER 被豁免 — 我们不希望 IdP 故障将密钥保管者锁定
        // （反映 SSO RFC §11 决定）。
        const enforcing = await prisma.identityProvider.findFirst({
          where: {
            enforceForLogin: true,
            enabledAt: { not: null },
            organization: {
              memberships: {
                some: {
                  userId: user.id,
                  role: { not: OrgRole.OWNER },
                },
              },
            },
          },
          select: { id: true, organization: { select: { slug: true } } },
        });
        if (enforcing) {
          logger.info(
            { userId: user.id, providerId: enforcing.id },
            'sso-enforced-credentials-blocked',
          );
          throw new SsoRequiredError();
        }

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          role: user.role,
          sessionVersion: user.sessionVersion,
          twoFactorEnabled: user.twoFactorEnabled,
          status: user.status,
          // RFC 0005 — 将 User 行的区域传播到 Auth.js
          // 用户对象，以便 `authConfig.callbacks.jwt` 可以标记
          // 令牌。上面的复合唯一 findUnique 已限制为
          // `currentRegion()`，所以这总是锁步的。
          region: user.region,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user, trigger, session, account, profile, isNewUser }) {
      // 初始登录：委托给边缘安全回调，以便我们为
      // 基本声明保持一个真实来源。
      const base = await authConfig.callbacks.jwt({
        token,
        user,
        trigger,
        session,
        account,
        profile,
        isNewUser,
      });
      if (!base) return base;

      // ── 初始登录：铸造一个新鲜的 sid + DeviceSession 行 ─────────
      if (user && base.id) {
        const rawSid = generateSid();
        try {
          const h = await headers();
          await createDeviceSession({
            userId: base.id as string,
            rawSid,
            userAgent: h.get('user-agent'),
            ip:
              h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
              h.get('x-real-ip') ??
              h.get('cf-connecting-ip') ??
              null,
          });
          base.sid = rawSid;
          base.sidHash = hashSid(rawSid);
        } catch (err) {
          // 如果 DeviceSession 写入失败，JWT 仍会被签发 —
          // 但没有 sid 声明，下面的验证分支将其视为
          // "legacy / pre-RFC-0002 token" 并让其通过一次。
          logger.error({ err, userId: base.id }, 'device-session-create-failed');
        }
      }

      // 重新验证所有后续调用以防对抗 DB，
      // 所以被撤销的令牌（sessionVersion 碰撞）被硬杀。
      // 一个索引的 PK 查找；便宜。
      if (!user && base.id) {
        const fresh = await prisma.user.findUnique({
          where: { id: base.id as string },
          select: {
            sessionVersion: true,
            role: true,
            twoFactorEnabled: true,
            status: true,
            region: true,
          },
        });
        if (!fresh) {
          // 用户被删除 — 完全使令牌无效。
          return null;
        }
        if (fresh.sessionVersion !== base.sessionVersion) {
          return null;
        }
        // 在令牌中反映当前角色（例如管理员提升
        // 在下一个请求时生效，而无需强制重新登录）。
        base.role = fresh.role;
        // RFC 0002 PR-4 — 保持 `status` 同步，
        // 以便中间件在操作提交时立即看到
        // PENDING_DELETION 翻转，无需等待新鲜的 JWT 铸造。
        base.status = fresh.status;
        // RFC 0005 — 区域在 User 行上是不可变的，
        // 但 pre-RFC-0005 令牌不会声称它。
        // 从 DB 刷新，以便中间件总是有一个区域来对抗
        // `currentRegion()` 进行比较。
        base.region = fresh.region;

        // ── RFC 0002 PR-2: tfa_pending 状态机 ──────────────────
        //
        // 这里处理了三个转换：
        //   (a) 使用 `session.tfa === 'verified'` 的 `update` 触发器
        //       清除标志 — 这是 /login/2fa 的成功路径。
        //   (b) 2FA 刚被禁用（DB 显示 false） → 清除标志
        //       以便用户不会卡在质询页面上。
        //   (c) 2FA 在会话中间被启用 → 设置标志，
        //       以便用户在任何进一步操作前被推送到质询。
        if (trigger === 'update' && (session as { tfa?: string } | undefined)?.tfa === 'verified') {
          base.tfa_pending = false;
        } else if (!fresh.twoFactorEnabled) {
          base.tfa_pending = false;
        } else if (fresh.twoFactorEnabled && base.tfa_pending !== false) {
          // 预先存在的令牌（早于 PR-2）不会设置
          // tfa_pending。一旦 2FA 开启，将 undefined
          // 视为"需要质询"，以便启用 2FA 的用户
          // 不能用旧令牌绕过。
          if (base.tfa_pending === undefined) {
            base.tfa_pending = true;
          }
        }

        // ── 每会话 sid 验证 ────────────────────────────────
        //
        // 早于 PR-1 的令牌不携带 sid；让它们通过
        // 直到自然轮换。新令牌必须指向未撤销的
        // DeviceSession 行，否则我们硬拒绝（=下一个请求上强制
        // 重新登录）。
        if (typeof base.sid === 'string' && base.sid.length > 0) {
          const result = await validateDeviceSession(base.sid);
          if (!result.ok) {
            return null;
          }
          // 保持 sidHash 与滚动的 jwt 同步 —
          // 会话回调（边缘安全）读取这个以在 UI 中标记
          // "当前"设备。
          base.sidHash = result.sidHash;
        }
      }

      return base;
    },
  },
});
