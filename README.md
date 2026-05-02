# Kitora

> 生产级 Next.js SaaS 启动模板 — 一次搭建，到处复用。

Kitora 是一个基于 Next.js 的全栈 SaaS 基础框架，提供从零到可全球部署产品所需的一切基建。注重开发体验、可扩展性与开箱即用性。初期以海外市场为主，中期将支持中国地区。

---

## 🌐 Multi-region 部署（RFC 0005）

Kitora 是 **share-nothing 多区域**架构：每个区域（kitora.io / kitora.cn / kitora.eu）是一套**完全独立的部署**——独立数据库、独立 Redis、独立对象存储、独立邮件 / 支付 provider。**用户和 Org 在注册时永久绑定一个 region**，跨 region 不打通账号、不共享数据、不做迁移。

部署时只需一个环境变量决定身份：

```env
KITORA_REGION=GLOBAL   # 或 CN / EU
```

| Region   | 域名      | 状态                                                                                      | 部署文档                                         |
| -------- | --------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `GLOBAL` | kitora.io | ✅ 当前默认（Stripe / Resend / S3）                                                       | [`docs/deploy/global.md`](docs/deploy/global.md) |
| `CN`     | kitora.cn | ✅ 工程层完成（阿里云 OSS / DirectMail / Alipay+WeChat / ioredis）；备案 / 商户开户进行中 | [`docs/deploy/cn.md`](docs/deploy/cn.md)         |
| `EU`     | kitora.eu | ⏸ 占位（按需启用）                                                                        | [`docs/deploy/eu.md`](docs/deploy/eu.md)         |

代码里读 region 永远走 `currentRegion()`（`src/lib/region.ts`），第三方 provider 永远走 `src/lib/region/providers.ts` 的 factory。设计动机和实施细节见 [RFC 0005](docs/rfcs/0005-data-residency.md)；CN 区落地工程详情见 [RFC 0006](docs/rfcs/0006-cn-region-deployment.md)。

CN 部署 pipeline（`.github/workflows/deploy-cn.yml`）走 GitHub OIDC → Aliyun ACR → ACK rollout，启用前需要先完成 ICP 备案、Aliyun 实名、商户开户三件事；这部分非代码，预计 25 工作日，详见 RFC 0006 §3 与 `docs/deploy/cn.md`。

---

## ✨ 功能特性

- ⚡ **Next.js App Router** — 支持 SSR、SSG 与 API 路由的全栈框架
- 🔐 **用户认证** — 注册、登录、重置密码流程开箱即用
- 💳 **支付集成** — 订阅计费功能脚手架已就绪
- 🌍 **国际化支持** — i18n 架构，面向全球市场
- 🎨 **UI 组件库** — 预置可访问性友好的基础组件
- 🗄️ **数据库层** — ORM 配置 + 迁移支持
- 📧 **邮件服务** — 事务性邮件集成
- 🔒 **安全防护** — CSRF 防护、限流、安全响应头
- 📊 **数据分析** — 基础埋点钩子，随时接入分析平台
- 🚀 **一键部署** — 针对 Vercel 部署优化

---

## 🛠 技术栈

底层骨架（与 region 无关）：

| 层级     | 技术选型                                                             |
| -------- | -------------------------------------------------------------------- |
| 框架     | Next.js 14+（App Router · server actions · edge middleware）         |
| 语言     | TypeScript（严格模式 + zod runtime 校验）                            |
| 样式     | Tailwind CSS + shadcn/ui                                             |
| 数据库   | PostgreSQL + Prisma                                                  |
| 认证     | Auth.js v5（Credentials + GitHub/Google OAuth + WebAuthn/Passkey）   |
| SSO      | BoxyHQ saml-jackson（SAML 2.0 + OIDC）+ SCIM v2                      |
| 国际化   | next-intl（en / zh）                                                 |
| 后台任务 | 自研 Postgres-backed jobs 系统（RFC 0008，`FOR UPDATE SKIP LOCKED`） |
| 可观测性 | Sentry + pino + Prometheus `/api/metrics` + AuditLog                 |
| 测试     | Vitest（单测）+ Playwright（e2e）                                    |
| 工程化   | ESLint + Prettier + commitlint + husky + lint-staged                 |

按 region 切换的 provider（factory 走 `src/lib/region/providers.ts`）：

| 模块     | GLOBAL / EU                           | CN                                          |
| -------- | ------------------------------------- | ------------------------------------------- |
| 计费     | Stripe                                | 支付宝 + 微信支付（周期扣款 + Native 扫码） |
| 邮件     | Resend                                | 阿里云 DirectMail                           |
| 对象存储 | Amazon S3（或兼容）                   | 阿里云 OSS                                  |
| 限流 KV  | Upstash Redis（REST）                 | 阿里云 Redis（ioredis TCP，VPC 内网）       |
| 部署     | Vercel / Fly Machines / 自托管 Docker | 阿里云 ACK + ACR + GitHub OIDC pipeline     |

---

## 🚀 快速开始

### 环境要求

- Node.js 22+
- pnpm（推荐）
- PostgreSQL 数据库

### 安装

```bash
# 克隆仓库
git clone https://github.com/your-username/kitora.git
cd kitora

# 安装依赖
pnpm install
```

### 环境变量约定

工程使用 **两层 env**：

| 文件         | 入 git        | 用途                                                                                                  |
| ------------ | ------------- | ----------------------------------------------------------------------------------------------------- |
| `.env`       | ✅ committed  | 非秘密的本地默认值（`DATABASE_URL` 指本地 docker、占位 `AUTH_SECRET` 等）。clone 完即可跑 dev/build。 |
| `.env.local` | ❌ gitignored | 真 secret —— 真 `AUTH_SECRET`、Stripe / Resend / OAuth client secret、生产数据库等。                  |

生产部署时把这些 secret 配在平台后台（Vercel / Fly / Railway 的环境变量面板），**不要**把 `.env.local` 部上去。Next.js 的加载顺序保证 `.env.local` 永远覆盖 `.env`，无需任何特殊处理。

### 本地需要真功能时填什么

新建 `.env.local`，按需写入：

```env
# 必须覆盖：production 安全用的真 AUTH_SECRET
AUTH_SECRET="<openssl rand -base64 32 的输出>"

# 可选：OAuth、Stripe、Resend、限流 ……（不填 = 该模块进入 noop / disabled）
AUTH_GITHUB_ID="..."
AUTH_GITHUB_SECRET="..."
STRIPE_SECRET_KEY="sk_test_..."
RESEND_API_KEY="re_..."
```

### 启动开发环境

```bash
# 起 PostgreSQL & Redis（也可以连云端实例，跳过此步）
docker compose up -d postgres redis

# 生成 Prisma client（首次必跑）
pnpm db:generate

# 跑数据库迁移
pnpm db:migrate

# 灌入种子数据（可选）
pnpm db:seed

# 启动开发服务器
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000) 查看效果。健康检查：[http://localhost:3000/api/health](http://localhost:3000/api/health)。

---

## 📚 文档导航

新同事/贡献者建议从 [`docs/getting-started/`](docs/getting-started/) 入手，再按需翻其他两个目录。

| 目录                                             | 内容                                                         | 何时读                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| [`docs/getting-started/`](docs/getting-started/) | 入门资料：速通对照（按背景）、4–6 周体系化学习路线、模块深挖 | 第一次接触本仓库时；想从能改 issue 升级为模块负责人时                  |
| [`docs/rfcs/`](docs/rfcs/)                       | 重大架构决策的提案与权衡（含活索引表）                       | 看代码不理解"为什么这样设计"时；动手做跨多 PR / 影响数据模型的工作之前 |
| [`docs/deploy/`](docs/deploy/)                   | 各 region 的部署蓝图（GLOBAL / CN / EU）                     | 第一次部署到某 region 时；运维排障时                                   |

API 契约见 [`openapi/v1.yaml`](openapi/v1.yaml)，运行时浏览 `/<locale>/docs/api` 查交互式文档（Scalar 渲染）。

---

## 📁 项目结构

```
kitora/
├── src/
│   ├── app/
│   │   ├── [locale]/
│   │   │   ├── (admin)/             # 管理后台（用户 / 订阅 / Stripe events / API tokens / Jobs / 审计）
│   │   │   ├── (auth)/              # 登录 / 注册 / 邮箱验证 / 重置密码 / 2FA / Passkey
│   │   │   ├── (dashboard)/         # 受保护的控制台 + onboarding + settings（账户 / 安全 / 计费 / Org / SSO / Webhook）
│   │   │   ├── (marketing)/         # 公开营销页面 + ICP / pricing / region-mismatch / legal
│   │   │   ├── docs/                # OpenAPI Scalar 交互式文档
│   │   │   ├── invite/[token]/      # Org 邀请落地页
│   │   │   ├── error.tsx            # 全局错误边界
│   │   │   └── not-found.tsx        # 404
│   │   ├── api/
│   │   │   ├── auth/                # Auth.js v5 + WebAuthn + SSO 回调
│   │   │   ├── billing/             # 支付宝 / 微信支付 webhook（CN region）
│   │   │   ├── stripe/              # Stripe checkout / portal / webhook
│   │   │   ├── scim/v2/             # SCIM v2 用户 / 组同步
│   │   │   ├── v1/                  # 公开 REST API（/me / /orgs/...）
│   │   │   ├── exports/[jobId]/     # GDPR 数据导出下载
│   │   │   ├── jobs/tick/           # Vercel Cron 后台任务入口
│   │   │   ├── openapi/v1.yaml/     # OpenAPI 契约 raw 文件
│   │   │   ├── health/              # DB / Redis 探测
│   │   │   └── metrics/             # Prometheus 指标
│   │   ├── globals.css
│   │   ├── robots.ts
│   │   └── sitemap.ts
│   ├── components/
│   │   ├── ui/                      # shadcn/ui 组件
│   │   ├── account/                 # 设置页 cards（2FA / Passkey / Sessions / SSO / Members / Webhook）
│   │   ├── admin/                   # 管理后台 UI
│   │   ├── auth/                    # 登录 / 注册 / 重置 / 2FA challenge
│   │   ├── billing/                 # checkout button / portal / 订阅卡
│   │   ├── dashboard/               # 控制台导航 / 用户菜单
│   │   ├── docs/                    # OpenAPI 文档站客户端组件
│   │   ├── marketing/               # 站点 header / footer / pricing
│   │   ├── providers/               # ThemeProvider 等
│   │   ├── theme-toggle.tsx
│   │   └── locale-switcher.tsx
│   ├── lib/
│   │   ├── account/                 # 账户 / 设备会话 / 2FA / Passkey / 删除流
│   │   ├── admin/                   # admin 后台 server actions
│   │   ├── auth/                    # Auth.js 配置 + Credentials + JWT 状态机
│   │   ├── billing/provider/        # billing provider 抽象 + Stripe / 支付宝 / 微信实现（RFC 0006）
│   │   ├── data-export/             # GDPR ZIP 工件构建 + cron sweep（RFC 0002 PR-3）
│   │   ├── email/                   # Resend / Aliyun DirectMail 邮件抽象
│   │   ├── jobs/                    # 通用后台任务系统（RFC 0008）
│   │   ├── orgs/                    # 多租户 / Membership / Invitation / SSO / Webhook 端点
│   │   ├── region/                  # 按 region 切换的 provider factory
│   │   ├── sso/                     # BoxyHQ saml-jackson 包装 + SCIM provision
│   │   ├── storage/                 # 对象存储抽象（Local FS / S3 / 阿里云 OSS）
│   │   ├── stripe/                  # Stripe client / customer / plans
│   │   ├── webauthn/                # Passkey 注册 / 验签 / 匿名挑战（RFC 0007）
│   │   ├── webhooks/                # 出站 webhook 签名 + 投递 cron + DLQ（RFC 0003）
│   │   ├── db.ts                    # Prisma client 单例
│   │   ├── logger.ts                # pino 日志
│   │   ├── analytics.ts             # 埋点抽象
│   │   ├── rate-limit.ts            # Upstash + Aliyun Redis 双轨限流
│   │   ├── region.ts                # currentRegion() — 进程级缓存 + 弃用警告
│   │   ├── region-parse.ts          # 零依赖纯函数 — Edge / Node 共享解析逻辑
│   │   ├── api-auth.ts              # Bearer token 鉴权（公开 API）
│   │   ├── api-org-gate.ts          # 公开 API 的 org 路径校验
│   │   ├── audit.ts                 # AuditLog 写入封装
│   │   └── utils.ts                 # cn / formatDate / formatCurrency
│   ├── emails/                      # React Email 模板
│   ├── i18n/                        # next-intl routing & request config
│   ├── types/                       # 全局类型 (next-auth.d.ts 等)
│   ├── env.ts                       # zod + @t3-oss/env 校验
│   └── middleware.ts                # i18n + auth + region + 2FA + 删除宽限中间件
├── messages/                        # 翻译文件 en.json / zh.json
├── prisma/                          # schema.prisma + 19 个 migrations + seed.ts
├── tests/e2e/                       # Playwright e2e 套（19 个 spec）
├── scripts/                         # CLI 入口（jobs / 数据导出 / 删除 / OpenAPI / egress audit）
├── openapi/                         # OpenAPI 3.1 契约 + 多语言 verify 示例
├── docs/                            # rfcs / deploy / getting-started 三组文档
├── infra/aliyun/                    # CN 部署 Terraform（VPC / RDS / Redis / OSS / ACK / SLS）
├── .github/workflows/               # CI（含 deploy-cn.yml）
├── Dockerfile · docker-compose.{,cn,eu}.yml  # 部署
└── public/                          # 静态资源
```

---

## 🔧 作为模板复用

Kitora 设计上支持克隆后直接用于新项目，复用步骤如下：

1. **重命名项目** — 全局替换 `kitora` 为你的项目名
2. **更新环境变量** — 填入自己的 API 密钥
3. **自定义品牌风格** — 修改 `tailwind.config.ts` 中的颜色与字体
4. **开发业务功能** — 基建已就绪，在此之上直接叠加业务逻辑

---

## 🗺 开发计划

- [x] 项目脚手架与基础架构搭建
- [x] 用户认证流程（Auth.js v5 · Credentials + GitHub/Google OAuth）
- [x] 订阅计费脚手架（Stripe Checkout / Portal / Webhook）
- [x] 用户控制台骨架
- [x] 国际化 — 英文 + 中文（next-intl）
- [x] 安全防护（headers · 限流 · 输入校验）
- [x] CI（GitHub Actions · lint / typecheck / build）
- [x] 邮箱验证与忘记密码完整流程
- [x] 管理后台（概览指标 · 用户管理 · 订阅列表）
- [x] E2E 测试脚手架（Playwright · auth / admin / 重置密码）
- [x] 操作审计日志（角色变更 / 改密 / 删除账号 / 登出全部）
- [x] Sentry 错误上报（client / server / edge · source map）
- [x] Stripe Webhook 加固（事件去重 · checkout 补全 · 订阅变更审计）
- [x] Connected Accounts（OAuth 提供商绑定 / 解绑）
- [x] API Tokens（生成 / 撤销 / Bearer 鉴权 · 明文仅显示一次）
- [x] 公开 REST API（`/api/v1/me` · 按 token 限流 · admin 后台总览）
- [x] Stripe 事件面板（按 type 过滤 / 分页 · admin 可见）
- [x] Loading skeletons（dashboard / billing / settings / admin 全覆盖）
- [x] Email 模板统一布局 + 注册 welcome 邮件
- [x] Health 探测（DB / Redis）+ Prometheus `/api/metrics`
- [x] 中国区起步（region 切换 · 支付 provider 抽象 · ICP 备案页）
- [x] 多租户 / 团队协作（Organization · OWNER/ADMIN/MEMBER · 邀请流 · per-org 计费 · cookie 切换）
- [x] 安全合规进阶（Active Sessions · 2FA · GDPR 数据导出 · 30 天注销宽限 · Org 强制 2FA — RFC 0002）
- [x] CN 区落地工程层（Aliyun OSS / DirectMail / Alipay+WeChat 完整支付 / ioredis 限流 / `pnpm egress:check` / `/legal/data-rights` / `deploy-cn.yml` — RFC 0006）
- [x] 出站 Webhook 平台（HMAC 签名 / 8 阶指数退避 / 自动禁用 / DLQ / OpenAPI 3.1 + Scalar — RFC 0003）
- [x] 企业级 SSO（SAML 2.0 + OIDC via BoxyHQ Jackson · SCIM v2 用户 provision · 强制 SSO 登录 — RFC 0004）
- [x] WebAuthn / Passkey 双轨（与 TOTP 同级 2FA 因子 + 登录页 Discoverable 快捷登录 — RFC 0007）
- [x] 通用 Background Jobs 系统（Postgres `FOR UPDATE SKIP LOCKED` + 注册表式 handler + 4 档重试策略 + DLQ + admin 看板 — RFC 0008）

---

## 📈 监控 / 探测

`/api/health`：返回 `{ status, uptime, checks: { db, redis } }`，DB/Redis 任一探测失败则 `503`。可被 LB / 监控直接拉。

`/api/metrics`：Prometheus 文本格式（`gauge` / `counter`），需 ADMIN role 的 API token 鉴权：

```bash
curl -H "Authorization: Bearer kitora_..." https://app.kitora.com/api/metrics
```

输出 `kitora_users_total`、`kitora_subscriptions_active`、`kitora_audit_log_total` 等指标，直接接入 Prometheus / Grafana。

---

## 🔌 公开 API

提供少量 REST 端点，用 personal API token 鉴权：

```bash
# 在 settings → API tokens 创建一个 token，明文形如 kitora_<base64url>
curl -H "Authorization: Bearer kitora_..." https://app.kitora.com/api/v1/me
```

返回示例：

```json
{
  "id": "cl...",
  "email": "you@example.com",
  "name": "Jarvis",
  "role": "user",
  "emailVerified": true,
  "createdAt": "2026-04-25T00:00:00.000Z",
  "plan": {
    "id": "pro",
    "name": "Pro",
    "status": "active",
    "currentPeriodEnd": "2026-05-25T00:00:00.000Z",
    "cancelAtPeriodEnd": false
  }
}
```

按 token id 维度限流（默认 60 req/min，env 可调）。响应携带 `X-RateLimit-Remaining` / `X-RateLimit-Reset` 头。

---

## 🩻 错误上报（Sentry）

Sentry 已经接好，开关由环境变量决定，留空时**整个 SDK no-op，零网络请求**。最少只需一个 DSN：

```env
# 浏览器与服务端共用 — 留空就关闭
NEXT_PUBLIC_SENTRY_DSN=

# 上传 source map（可选，仅 CI build 阶段需要）
SENTRY_AUTH_TOKEN=
SENTRY_ORG=
SENTRY_PROJECT=
SENTRY_ENVIRONMENT=production
```

接入位置：

- `sentry.{client,server,edge}.config.ts` — 三个运行时各一份
- `src/instrumentation.ts` — Next.js boot hook，`NEXT_RUNTIME` 路由到对应 config
- `next.config.mjs` — `withSentryConfig` 包裹，仅当 `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` 同时存在才上传 source map
- `src/app/[locale]/error.tsx` 与 `src/app/global-error.tsx` — 错误边界手动 `captureException`
- `tunnelRoute: '/monitoring'` — 浏览器 SDK 走自家域绕过广告拦截器

---

## 🧪 端到端测试

E2E 跑在 Playwright 上，直连一个真实的 Postgres（**不要**用 dev 库）。

```bash
# 1) 拉一份独立的 Postgres，给测试用
docker run -d --name kitora-test-pg \
  -e POSTGRES_USER=kitora -e POSTGRES_PASSWORD=kitora -e POSTGRES_DB=kitora_test \
  -p 5433:5432 postgres:16-alpine

# 2) 指向它，跑迁移
export DATABASE_URL=postgresql://kitora:kitora@localhost:5433/kitora_test
pnpm db:generate
pnpm db:deploy

# 3) 装 Playwright 浏览器（首次）
pnpm test:e2e:install

# 4) 跑测试（自动 build + start，再驱动浏览器）
pnpm test:e2e
```

调试时建议两个终端：一个 `pnpm dev`，另一个 `E2E_NO_SERVER=1 pnpm test:e2e:ui`。

新加的 spec 放在 `tests/e2e/`，复用 `fixtures/test.ts` 里的 `testUser` / `adminUser` / `signIn`；测试结束自动清掉用户行。

---

## 🤝 参与贡献

目前为独立开发者项目，欢迎通过 GitHub Issues 提交问题或建议。

---

## 📄 开源协议

MIT © Jarvis
