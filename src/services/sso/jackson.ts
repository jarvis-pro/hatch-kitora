// 注意：这里刻意*不*设置 'server-only' — Playwright e2e 测试
// 在进程中驱动 SSO 登录流程（mock IdP 响应 → ACS → 会话
// 写入）并需要导入此适配器。Jackson 本身通过其 sql
// `engine` 配置仅是 Node，所以客户端打包无论如何都会失败。
//
// 围绕 `@boxyhq/saml-jackson` 的单例包装。库公开丰富的
// 控制器集 — 我们只需要一个切片用于 SSO 登录：
//
//   - `apiController`     — 管理 SAML / OIDC 连接（每个 IdP 行一个）。
//   - `oauthController`   — OAuth 风格 authorize / token / userinfo 流
//                           将 SAML AuthnResponse 桥接到
//                           code → access-token → profile，我们可以插入
//                           到 Auth.js。
//
// 租约：
//
//   tenant  = organization slug（每个租户每个协议一个 IdP）
//   product = "kitora"（常量 — Jackson 支持多产品但我们
//             只有一个）
//
// 库在第一个 `init()` 时自动在 `jackson_*` 前缀下创建自己的表，
// 通过 `engine: 'sql'` 配置共享我们的 PG 数据库。

import jackson, {
  type IConnectionAPIController,
  type IOAuthController,
  type JacksonOption,
} from '@boxyhq/saml-jackson';

import { env } from '@/env';

/**
 * `tenant` 值传递给 Jackson 对于我们注册的每个 IdP。我们使用
 * org 的 `slug` 因为它是 URL 安全的并且稳定；轮换它只会
 * 在显式 org 重命名的同时发生，这是罕见的。
 */
export const JACKSON_PRODUCT = 'kitora' as const;

const samlPath = '/api/auth/sso/saml/acs';
const oidcPath = '/api/auth/sso/oidc/callback';

let cached: Promise<{
  apiController: IConnectionAPIController;
  oauthController: IOAuthController;
}> | null = null;

/** 懒初 — 第一个调用者引导 Jackson + 创建 `jackson_*` 表。 */
export function getJackson(): Promise<{
  apiController: IConnectionAPIController;
  oauthController: IOAuthController;
}> {
  if (cached) return cached;

  // Jackson 自己的状态（OAuth 代码行、进行中的 SAML 会话）存在
  // 在内存中存储。我们刻意不与应用的其余部分共享 Postgres：
  //
  //   - 数据短期存在（< 5 分钟 TTL 对 Jackson 写入的每一行）。
  //   - Jackson 的 `engine: 'sql' + type: 'postgres'` 路径在 1.52.x
  //     在某些环境中崩溃，错误为"Native is not a constructor" —
  //     其嵌入式 knex/pg 组合期望本地绑定
  //     并非总是存在。
  //   - `IdentityProvider` 我们拥有的用户面对配置
  //     仍然存在于主 Prisma DB 中并且是跨重启的真实来源。
  //
  // 权衡：mid-SSO-flow 部署使一些用户命中 `state-mismatch`
  // 并重试。对已在用户侧重试的 B2B 登录路径可接受。
  const opts: JacksonOption = {
    externalUrl: env.NEXT_PUBLIC_APP_URL,
    samlAudience: env.NEXT_PUBLIC_APP_URL,
    samlPath,
    oidcPath,
    db: {
      engine: 'mem',
      cleanupLimit: 1000,
    },
  };

  cached = jackson(opts).then((ret) => ({
    apiController: ret.apiController,
    oauthController: ret.oauthController,
  }));
  return cached;
}

/** 便利用于仅需要 OAuth 切片的路由。 */
export async function getOauthController(): Promise<IOAuthController> {
  const { oauthController } = await getJackson();
  return oauthController;
}

/** 便利用于 IdP CRUD 管道。 */
export async function getConnectionController(): Promise<IConnectionAPIController> {
  const { apiController } = await getJackson();
  return apiController;
}
