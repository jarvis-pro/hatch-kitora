# RFC 0005 — 数据驻留 / 中国区（Multi-Region Share-Nothing）

| 状态     | **Implemented**（2026-04-27 落地于 v0.6.0；CN 区工程层 v0.7.0 完成）                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------- |
| 作者     | Jarvis                                                                                                              |
| 创建于   | 2026-04-26                                                                                                          |
| 影响版本 | 0.5.0 → 0.6.0（非破坏性，新增 Org/User/AuditLog 列 + region 运行时常量 + 中间件 + 部署 pipeline 区分 region）       |
| 关联     | RFC 0001 §10「region 占位」· RFC 0002（数据导出 / 删除合规）· RFC 0003（webhook 签名跨区域）· RFC 0004 §9「中国区」 |

---

## 1. 背景与目标

`/api/v1/me`、webhook 投递管线、企业级 SSO + SCIM 这些 v0.5.0 已经齐了，从功能矩阵看已经拿得出手去签五位数美元/年的 enterprise 合同。但下一道**采购流程的硬门槛**已经摆在面前——

- **中国区客户**：网信办 2017 网络安全法 + 2021 数据安全法 + 2021 个人信息保护法（PIPL）三件套要求"个人信息境内收集 → 境内存储 / 境内处理"；上海某金融客户 RFP 直接写「不接受数据存储于中国大陆境外的 SaaS」。光在境外集群上挂一个"中国数据库"实例不行，必须**全栈境内独立部署**。
- **EU 客户**（次优先级）：GDPR Article 44+ 数据传输条款 + 部分客户合同强制要求 EU residency。和中国区相比是"加分项"非"硬门槛"。

**所以 v1（本 RFC 落地范围）的目标只有一个**：把 codebase 改造成**可以在不同 region 独立部署**、彼此**share-nothing**（DB / Redis / 对象存储 / 邮件 / 域名 / 支付 / 监控全独立）、用户和 Org 在注册时**永久绑定一个 region**的形态。具体的中国区部署（ICP 备案、阿里云 RDS、阿里云 OSS、阿里云邮件推送、微信支付/支付宝接入）作为 follow-up RFC 0006 单独推。

非目标：

- ❌ **跨 region 数据复制 / 双活**——share-nothing 的核心就是不复制。同一邮箱在 us / cn 注册视为两个独立账号。
- ❌ **跨 region 单点登录**——Auth.js session 不跨域。`kitora.io` 和 `kitora.cn` 是两套完全独立的 cookie 域。
- ❌ **运行时 region 切换**——region 是部署时常量，不是请求时变量。一个进程启动后只服务一个 region。

---

## 2. 设计原则

| 原则                         | 解释                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **share-nothing**            | 每个 region 是独立 stack。`KITORA_REGION` 是部署时环境变量，进程内不可变。任何跨 region 调用都是 HTTP，不是数据库连接。                         |
| **数据不出境**               | 中国区用户的任何 PII（包括 audit log 里的 IP / userAgent）**不允许**流到境外集群。审计 / 监控 / 日志聚合也得本地化（监管会检查 SLS 索引落点）。 |
| **region 是 Org 的属性**     | 不是 User 的属性。一个用户可以在多个 region 各有一个账号，但单个 Org 只能存在于一个 region。Membership 自然也单 region。                        |
| **不依赖运行时 region 路由** | 客户端按域名（`kitora.io` / `kitora.cn`）分流到不同集群，而不是单一入口 + 后端路由。理由：监管需要的是**网络层隔离**，不是应用层 if/else。      |
| **配置而不是代码**           | 第三方服务（支付 / 邮件 / 存储 / OAuth）按 region 选 provider，但选择逻辑写在 `lib/region.ts` 的 provider factory，不要散落在业务代码里。       |
| **降级先于扩展**             | v1 只支持 `global` 一个 region（即当前已部署的 stack），但所有改动都按多 region 抽象写。CN region 作为 RFC 0006 上线，不在本 RFC 范围。         |

---

## 3. 数据模型变更

### 3.1 新增枚举

```prisma
enum Region {
  GLOBAL  // us-east 默认 stack，对应 kitora.io（v1 唯一支持的 region）
  CN      // 中国大陆，对应 kitora.cn（RFC 0006 启用）
  EU      // 欧盟，对应 kitora.eu（占位，未来启用）
}
```

放在 `prisma/schema.prisma` 文件头部，与 `OrgRole` / `SsoProtocol` 同级。

### 3.2 Organization 加 region 列

```prisma
model Organization {
  // ... 现有字段
  region    Region   @default(GLOBAL)

  @@index([region])
}
```

- **不可变约束**：写入后不允许 update。在 `updateOrganization` server action 入口做 `if (existing.region !== input.region) throw`。
- 创建时自动取自 `process.env.KITORA_REGION`（启动时校验过）。`createOrganizationAction` 不接受外部传入的 region 参数。
- 已有数据迁移：全部 backfill 为 `GLOBAL`（迁移文件里 `UPDATE "Organization" SET region = 'GLOBAL' WHERE region IS NULL`，再加 `NOT NULL`）。

### 3.3 User 加 region 列

```prisma
model User {
  // ... 现有字段
  region    Region   @default(GLOBAL)

  @@unique([email, region])  // 同邮箱可在不同 region 各注册一次
  @@index([region])
}
```

- 注释：现有 `email` 唯一索引需要 drop 后改成 `(email, region)` 复合唯一。
- 注册时自动取 `process.env.KITORA_REGION`，用户不能选。
- **JIT / SCIM provisioning 同理**：SAML / OIDC 注册的 User 用进程 region；SCIM POST `/api/scim/v2/Users` 创建时 region 取 IdP 所在 Org 的 region（强约束：IdP.Org.region === process.env.KITORA_REGION，否则 401）。

### 3.4 AuditLog 加 region 列

```prisma
model AuditLog {
  // ... 现有字段
  region    Region   @default(GLOBAL)

  @@index([region, createdAt])
}
```

- 写时自动 stamp 当前进程 region，不通过参数透传。
- 用途：合规审计要"区分 region 出报表"，索引必须 region 在前。

### 3.5 Subscription / 其他扩展

不加 region 列。原因：Subscription 只能挂在 Org 上，间接通过 `Subscription.org.region` 查询；加列只会增加冗余和不一致风险。

迁移文件路径：`prisma/migrations/20260427_add_region_columns/migration.sql`。

---

## 4. Region 运行时

### 4.1 入口常量

新建 `src/lib/region.ts`：

```ts
import 'server-only';

import { Region } from '@prisma/client';

import { env } from '@/env';

/**
 * 当前进程服务的 region。**进程启动时确定**，运行时不可变。
 *
 * 通过 `KITORA_REGION` 环境变量设置；未设置时默认 GLOBAL（开发 + 测试默认）。
 *
 * 任何写库 / 调外部 API 的代码都应当从这里取，**禁止**直接读 `process.env.KITORA_REGION`。
 */
export function currentRegion(): Region {
  const raw = env.KITORA_REGION ?? 'GLOBAL';
  if (raw in Region) return raw as Region;
  throw new Error(`Invalid KITORA_REGION="${raw}"`);
}

/** 是否为中国区部署 —— ICP 备案号、邮件 provider、支付 provider 切换时用 */
export function isCnRegion(): boolean {
  return currentRegion() === Region.CN;
}
```

`env.KITORA_REGION` 加进 `src/env.ts` 的 zod schema：`z.enum(['GLOBAL', 'CN', 'EU']).default('GLOBAL')`。注：现有 `REGION: z.enum(['global', 'cn'])` 是大小写小写形式，本 RFC 把它**重命名 + 升级**为 `KITORA_REGION` 大写形式以对齐 Prisma 枚举（迁移期保留旧 `REGION` 兼容 1 个版本）。

### 4.2 Provider factory

`src/lib/region/providers.ts` 集中管理按 region 选 provider 的逻辑：

```ts
import { currentRegion } from '@/lib/region';

export function getEmailProvider() {
  switch (currentRegion()) {
    case 'CN':
      return aliyunDirectMailProvider; // 阿里云邮件推送
    default:
      return resendProvider;
  }
}

export function getStorageProvider() {
  switch (currentRegion()) {
    case 'CN':
      return aliyunOssProvider;
    default:
      return s3Provider;
  }
}

export function getBillingProvider() {
  switch (currentRegion()) {
    case 'CN':
      return wechatPayProvider; // 或支付宝，二选一
    default:
      return stripeProvider;
  }
}
```

v1 只实现 `default` 分支（保持 stripe / resend / s3）；CN 分支写 `throw new Error('not implemented in v0.6.0')` 占位，留给 RFC 0006。

### 4.3 中间件守卫（Region 一致性）

`src/middleware.ts` 加一段：登录态用户的 `User.region` 必须等于 `currentRegion()`，否则强制登出 + 重定向到「请去 [kitora.cn](https://kitora.cn) 登录」提示页。

```ts
// pseudo-code
if (session?.user?.region && session.user.region !== currentRegion()) {
  return redirect(`/region-mismatch?expected=${session.user.region}`);
}
```

防止的场景：用户在 GLOBAL 注册过，session cookie 被错误带到 CN 域名下（理论上不会发生，因为 cookie domain 不同；但保险起见在 server 端再校验一次）。

### 4.4 Audit / Webhook stamp

- `recordAudit()` 内部自动 fill `region: currentRegion()`，调用方无需关心。
- `enqueueWebhook()` 同理：投递的 endpoint URL 必须落在同一 region（DB 里只能存对应 region 的 endpoint，因为 Org.region 已经卡死了），不会有跨 region 投递场景。

---

## 5. 跨 Region 边界

| 场景                            | v1 行为                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同邮箱在 us / cn 各注册一次     | 视为两个独立 User，不打通。注册页清楚提示「kitora.cn 是中国区独立账号体系」                                                                                               |
| 用户从 kitora.io 切到 kitora.cn | 重新走注册流程；不支持迁移工具（监管视角下"迁移"等于跨境传输，有合规风险）                                                                                                |
| Org 跨 region 邀请              | **禁止**。invite email 域名必须在同一 region 注册。Server action 校验：被邀请人 User.region === 当前 Org.region                                                           |
| SAML / OIDC IdP                 | 一个 IdP 只能挂在一个 Org 上（RFC 0004 §4.2 已约束），间接 region-bound。emailDomains 必须只覆盖该 region 的合法域                                                        |
| SCIM provisioning               | 同 §3.3，Bearer token 只在本 region 有效                                                                                                                                  |
| Webhook 出站                    | 投递目标 URL **不限 region**——用户的 webhook receiver 就是境外服务也允许（这是用户自己的 outbound 数据，监管不管）。但 Stripe 等内部触发的 webhook 永远在本 region 内闭环 |
| 公开 API（`/api/v1/*`）         | API token 与 region 绑定，token 由本 region 集群签发的不能用于另一 region                                                                                                 |
| OpenAPI 文档站（`/docs/api`）   | 每个 region 各自渲染 spec；spec 内 `servers:` 字段写本 region 的 base URL                                                                                                 |
| 数据导出（RFC 0002 PR-3）       | 导出文件落本 region 的对象存储；下载链接也必须是本 region 的预签名 URL                                                                                                    |
| 账户删除（RFC 0002 PR-4）       | 只删本 region 的数据；同邮箱在另一 region 的账号需用户自己另行删除                                                                                                        |

---

## 6. 部署架构（v1 单 region 原型）

```
                      ┌────────────────────────────────────┐
                      │      kitora.io（GLOBAL region）    │
                      │                                    │
   user (global) ─────┤  Vercel / Cloud Run                │
                      │  Postgres (Neon us-east)           │
                      │  Redis (Upstash us-east)           │
                      │  S3 (us-east-1)                    │
                      │  Resend / Stripe / Sentry          │
                      └────────────────────────────────────┘

                      ┌────────────────────────────────────┐
                      │   kitora.cn（CN region，RFC 0006） │
                      │                                    │
   user (china) ──────┤  阿里云 ACK 上海集群                │
                      │  阿里云 RDS PostgreSQL（华东 2）   │
                      │  阿里云 Redis（华东 2）             │
                      │  阿里云 OSS（cn-shanghai）          │
                      │  阿里云邮件推送 / 微信支付 / SLS    │
                      └────────────────────────────────────┘
```

v1 落地的是上半部分（`KITORA_REGION=GLOBAL` 的 kitora.io stack 强化），下半部分留给 RFC 0006。

### 6.1 Dockerfile + 环境变量

`Dockerfile` 加 `ARG KITORA_REGION=GLOBAL` + `ENV KITORA_REGION=$KITORA_REGION`。CI 在 build 阶段注入。

### 6.2 docker-compose 区分

`docker-compose.yml` 改名为 `docker-compose.global.yml`（保留），新增：

- `docker-compose.cn.yml`（v1 占位，仅写注释 `# RFC 0006 实施`）
- `docker-compose.eu.yml`（占位）

每份 compose 用独立的 db volume / redis volume，确保本地开发不会混。

### 6.3 README + 部署 runbook

`docs/deploy/global.md`（v1 写完）+ `docs/deploy/cn.md`（v1 占位 stub，列出 ICP 备案 / 公安备案 / 阿里云资源采购清单）+ `docs/deploy/eu.md`（占位）。

### 6.4 域名 + 证书

v1 不动当前 `kitora.io` 域名。RFC 0006 时再开 kitora.cn（需 ICP 备案，约 20 工作日）。

---

## 7. 实施路线（v1）

### PR-1 Schema + Region 运行时

- 加 `Region` 枚举 + `Organization.region` / `User.region` / `AuditLog.region` 列 + 迁移。
- `User.email` 唯一索引改 `(email, region)` 复合唯一。
- 新建 `src/lib/region.ts` 导出 `currentRegion()` / `isCnRegion()`。
- `src/env.ts` 把 `REGION` 重命名为 `KITORA_REGION`，值改大写枚举对齐 Prisma；保留 `REGION` 兼容 1 个版本（`logger.warn` 提示已过时）。
- `recordAudit` / `provisionSsoUser` / SCIM `POST Users` 等所有写入 User / Membership / AuditLog 的入口自动 stamp `region`。
- e2e：建两个 region 的 User（同邮箱）→ 验证不会冲突；删除其中一个不影响另一个。

### PR-2 Region 中间件 + Provider factory

- `src/middleware.ts` 加 region-mismatch 守卫。
- 新建 `src/lib/region/providers.ts`，给 email / storage / billing 三个 provider 加 region switch（CN 分支抛 `not-implemented`）。
- `createOrganizationAction` / 邀请 / SSO start 等所有跨 Org 操作加 `region` 一致性校验。
- 单 region 部署的 v1 不会触发任何 CN 分支，但代码路径要在。
- e2e：构造 session.region !== currentRegion() 的请求 → 断言重定向到 `/region-mismatch`。

### PR-3 Deploy pipeline + 文档

- `Dockerfile` 加 `ARG KITORA_REGION` + `ENV`。
- `docker-compose.global.yml` 重命名（原 `docker-compose.yml`），加 `KITORA_REGION=GLOBAL`。
- `docker-compose.cn.yml` / `docker-compose.eu.yml` 占位 + 注释。
- `docs/deploy/global.md` 写完整部署 runbook（指向当前生产）。
- `docs/deploy/cn.md` 写 ICP 备案 / 阿里云资源 / 邮件 SMTP / OSS bucket 命名规范的 stub（不要求执行）。
- README 顶部加一段「Multi-region」简介。
- e2e：已有 e2e 全部能在 `KITORA_REGION=GLOBAL` 下跑通。

### 回滚

每个 PR 都是加法。PR-1 加列，回滚需 drop 列 + 删迁移；不影响数据。PR-2 + PR-3 纯应用层 / 配置层，回滚是 revert commit。

---

## 8. 权限矩阵补充

| Action           |  OWNER   | ADMIN | MEMBER |
| ---------------- | :------: | :---: | :----: |
| 查看 Org.region  |    ✓     |   ✓   |   ✓    |
| 修改 Org.region  |    ✗     |   ✗   |   ✗    |
| 查看 User.region | ✓ (自己) |   —   |   —    |
| 修改 User.region |    ✗     |   ✗   |   ✗    |

`region` 是部署时不可变属性，运行时任何角色都不能修改。`✗ ✗ ✗` 是技术约束，不是权限决定。

---

## 9. 风险与对策

| 风险                                                       | 对策                                                                                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 现有 `email` 唯一索引改 `(email, region)` 后老数据冲突     | 不存在冲突——v1 全部老数据 region = GLOBAL，`(email, GLOBAL)` 仍唯一。迁移 SQL 先 backfill 再加约束                                      |
| `KITORA_REGION` 环境变量配错（CN stack 启动时填了 GLOBAL） | 启动时校验：连库后比对 `Organization.region` 与 `currentRegion()` 是否一致，不一致直接 panic 退出；防止数据被写错 region                |
| 同邮箱跨 region 注册造成用户混淆                           | 注册页明示「这是 Kitora 中国区，与 kitora.io 是独立账号体系」；登录页也加同款提示                                                       |
| Org 邀请跨 region 用户                                     | 邀请 server action 加校验，UI 上输入邮箱后异步查 region；找不到匹配账号时提示「对方需在本 region 注册」                                 |
| 第三方 provider 在 CN region 不可用（Stripe / Resend）     | provider factory 强制按 region 选；CN 分支抛 `not-implemented` 是故意为之，逼着 RFC 0006 必须把 CN 替代品全套配齐才能上线               |
| 中国监管要求"日志保存 6 个月，可被随时调取"                | AuditLog 加 region 列 + 索引；导出工具按 region 过滤（RFC 0002 PR-3 已有 export 框架，本 RFC 加 region 维度）                           |
| 跨 region 数据传输被监管发现                               | 应用层禁止跨 region DB 连接；所有 fetch 出 region 的请求都要走明确的 outbound webhook 路径（用户配置的 endpoint，监管视角属于用户行为） |
| 同邮箱在 us 已注册，去 cn 注册时不知情                     | 接受不知情——本 RFC 不做账号迁移工具，理由见 §1 非目标。文档明示                                                                         |
| ICP 备案下来前 kitora.cn 不能解析                          | RFC 0006 立项时第一步就是提 ICP 备案，预计 20 工作日；备案期间用 IP 白名单内部测试                                                      |

---

## 10. 工作量估算

| PR   | 内容                            | 估时    |
| ---- | ------------------------------- | ------- |
| PR-1 | Schema + region 运行时 + e2e    | 1 天    |
| PR-2 | 中间件 + provider factory + e2e | 1 天    |
| PR-3 | Deploy pipeline + 文档          | 0.5 天  |
| 合计 |                                 | ~2.5 天 |

中国区的实际部署（ICP 备案 + 阿里云资源 + provider 替换实现）作为 RFC 0006 单独估时，预计 30+ 天（备案占大头）。

---

## 11. 评审决策（v0.6 已定稿）

- [x] **region 枚举值** —— `GLOBAL` / `CN` / `EU`。✅ **采纳**。理由：与 Prisma `Region` 枚举大写对齐；`GLOBAL` 更准确表达"非中国非欧洲的默认 region"；与现有 `REGION='global'` 升级路径直接。
- [x] **现有 `REGION` 环境变量的兼容期** —— 1 个版本。✅ **采纳**。v0.6 + v0.7 接受 `REGION` 作为 alias（命中时 `currentRegion()` 触发一次 `logger.warn` 提示已过时），v0.8 移除。`KITORA_REGION` 同时存在时优先生效。
- [x] **跨 region 同邮箱注册** —— ✅ **允许，独立账号体系**。`User.@@unique([email, region])` 复合唯一替换原 `email @unique`；signup / SSO JIT / SCIM 三处 user 创建路径都按 region 隔离。
- [x] **Org 邀请校验时机** —— ✅ **server action 提交时校验**（在 `createInvitationAction` 内部 query 一次「同邮箱在其他 region 是否已存在」）。UX 上输入邮箱后才在提交瞬间报 `cross-region` 错误，可接受。
- [x] **AuditLog region 索引** —— ✅ **加 `(region, createdAt)` 复合索引**。Migration 已落地，合规报表按 region 切片即可命中索引前缀。
- [x] **CN 部署交付 RFC** —— ✅ **单独立项 RFC 0006**。本 RFC 仅做 codebase 多 region 化；CN 部署（ICP 备案 / 阿里云 / Aliyun DirectMail / Alipay·WeChat Pay）作 RFC 0006 落地，stub 已写入 `docs/deploy/cn.md`。
- [x] **EU region 启用时机** —— ✅ **占位**。`Region.EU` 已纳入 enum；`docker-compose.eu.yml` + `docs/deploy/eu.md` 占位文件已就绪；provider factory 暂时把 EU 视为 GLOBAL alias（Stripe / Resend / S3）。

## 12. 实施完成 (v0.6.0)

PR-1 / PR-2 / PR-3 全部落地，对应 commit 集合见 git log。落地清单：

- `prisma/schema.prisma` + `prisma/migrations/20260427000000_add_region_columns/` —— Region 枚举、三张表 region 列、`(email, region)` 复合唯一、AuditLog 复合索引。
- `src/lib/region.ts` —— `currentRegion()` / `isCnRegion()` 唯一入口；`KITORA_REGION` 优先，`REGION` 兼容并 deprecation warn。
- `src/lib/region/providers.ts` —— email / storage / billing factory；CN 分支故意 `throw not-implemented`，逼 RFC 0006 必须把 Aliyun 三件套配齐才能上线。
- `src/lib/region-startup-check.ts` + `src/instrumentation.ts` —— 启动时 panic 校验 DB region 与进程 region 一致。
- `src/middleware.ts` —— region-mismatch 守卫 + `/region-mismatch` i18n 提示页。
- `src/lib/auth/index.ts` —— 包装 `PrismaAdapter`（`getUserByEmail` / `createUser` 注入 region），让 OAuth provider 也走对路径。
- `Dockerfile` + `docker-compose.{global,cn,eu}.yml` —— `ARG KITORA_REGION` build-time 注入；GLOBAL 保持 `docker-compose.yml` 兼容现有 dev workflow。
- `docs/deploy/{global,cn,eu}.md` + README Multi-region 段。
- `tests/e2e/region.spec.ts` —— 复合唯一 / 跨 region 共存 / 删一边不影响另一边 / mismatch 页面渲染。

非交付：CN 实际部署、EU 启用、跨 region 账号迁移工具——三项明确不在本 RFC 范围（§1 非目标），交 RFC 0006 + 后续按需立项。
