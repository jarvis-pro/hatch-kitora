# Kitora

> 生产级 Next.js SaaS 启动模板 — 一次搭建，到处复用。

Kitora 是一个基于 Next.js 的全栈 SaaS 基础框架，提供从零到可全球部署产品所需的一切基建。注重开发体验、可扩展性与开箱即用性。初期以海外市场为主，中期将支持中国地区。

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

| 层级   | 技术选型                  |
| ------ | ------------------------- |
| 框架   | Next.js 14+（App Router） |
| 语言   | TypeScript                |
| 样式   | Tailwind CSS              |
| 数据库 | PostgreSQL + Prisma       |
| 认证   | NextAuth.js               |
| 支付   | Stripe                    |
| 邮件   | Resend                    |
| 部署   | Vercel                    |

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

## 📁 项目结构

```
kitora/
├── src/
│   ├── app/
│   │   ├── [locale]/
│   │   │   ├── (auth)/              # 登录 / 注册
│   │   │   ├── (dashboard)/         # 受保护的控制台页面
│   │   │   ├── (marketing)/         # 公开营销页面
│   │   │   ├── error.tsx            # 全局错误边界
│   │   │   └── not-found.tsx        # 404
│   │   ├── api/
│   │   │   ├── auth/[...nextauth]/  # Auth.js v5 路由
│   │   │   ├── stripe/              # checkout / portal / webhook
│   │   │   └── health/              # 健康检查
│   │   ├── globals.css
│   │   ├── robots.ts
│   │   └── sitemap.ts
│   ├── components/
│   │   ├── ui/                      # shadcn/ui 组件
│   │   ├── auth/                    # 登录 / 注册表单
│   │   ├── dashboard/               # 控制台导航 / 用户菜单
│   │   ├── marketing/               # 站点 header / footer
│   │   ├── providers/               # ThemeProvider 等
│   │   ├── theme-toggle.tsx
│   │   └── locale-switcher.tsx
│   ├── lib/
│   │   ├── auth/                    # Auth.js 配置 + Server Actions
│   │   ├── stripe/                  # Stripe client / customer / plans
│   │   ├── email/                   # Resend 客户端 + 发送封装
│   │   ├── db.ts                    # Prisma client 单例
│   │   ├── logger.ts                # pino 日志
│   │   ├── analytics.ts             # 埋点抽象
│   │   ├── rate-limit.ts            # Upstash 限流
│   │   ├── request.ts               # 请求上下文工具
│   │   └── utils.ts                 # cn / formatDate / formatCurrency
│   ├── emails/                      # React Email 模板
│   ├── i18n/                        # next-intl routing & request config
│   ├── types/                       # 全局类型 (next-auth.d.ts 等)
│   ├── env.ts                       # zod + @t3-oss/env 校验
│   └── middleware.ts                # i18n + auth 中间件
├── messages/                        # 翻译文件 en.json / zh.json
├── prisma/                          # schema.prisma + seed.ts
├── .github/workflows/               # CI
├── Dockerfile · docker-compose.yml  # 部署
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
- [ ] 中国区支持（支付宝 / 微信支付 · ICP / 备案）

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
