# Kitora 入手手册 · 给 Vue + Midway 同学的速通对照

> 目标：让一位熟练 Vue 3 + Node.js (Midway.js) 的工程师在 **1–2 周内**能够安全地接手 Kitora 的 issue，不只是会写页面，还能读懂 auth / billing / jobs / region 这些模块的设计意图。
>
> 阅读顺序建议：先把 §1 ~ §3 的"心智模型映射"看完，再按需翻 §4 各模块设计。代码细节请直接 `grep` 项目，本文档只讲**为什么这样设计**，不重复讲 API 怎么调。

---

## 1 · 你已经会的，可以直接迁移

下表把 Vue + Midway 圈子的高频概念，映射到本仓库的同位物。**等价物**栏可以直接套用既有直觉；**差异点**栏是真正需要认知刷新的地方。

| Vue / Midway 概念         | Kitora 等价物                                                     | 关键差异点                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `*.vue` 单文件组件        | `*.tsx` 函数组件                                                  | 没有 `<template>/<script>/<style>` 三段式；JSX 直接在函数 `return` 里写。样式靠 Tailwind class，**不**写 scoped CSS。             |
| `ref` / `reactive`        | `useState` / `useReducer`                                         | React 不是响应式系统，**赋值不会自动重渲**——必须调 setter。这是初期最容易踩的坑。                                                 |
| `computed`                | `useMemo`                                                         | 只在依赖项变化时重算；**永远要写 deps 数组**。                                                                                    |
| `watch` / `watchEffect`   | `useEffect`                                                       | 默认每次渲染都跑，靠 deps 数组裁剪。**不要把它当 watcher 用做派生状态**——用 `useMemo`。                                           |
| `provide` / `inject`      | React Context + Provider                                          | 见 `src/components/providers/`。                                                                                                  |
| Pinia store               | Context + `useReducer` / Server State                             | 本项目**几乎没有客户端全局 store**——服务端组件直接读 DB，客户端只用 Context 装"会话身份/Toast/主题"这种横切信息。                 |
| Vue Router                | Next.js App Router（文件即路由）                                  | 路径就是文件夹结构。`page.tsx` 渲染页面、`layout.tsx` 是布局、`loading.tsx` 是 Suspense fallback、`error.tsx` 是 error boundary。 |
| 路由守卫 `beforeEach`     | `middleware.ts` + 各页面 `getSession()`                           | 见 §4.2。中间件只做 i18n 重写 + 一些重定向，鉴权大多放在页面里 `await auth()`。                                                   |
| Midway Controller         | `src/app/api/**/route.ts`（REST）+ Server Actions                 | Next.js 的"Controller"被拆成两套：对外用 `route.ts`，前端表单调用首选 Server Actions（一种 RPC 风格）。                           |
| Midway Service / IoC 容器 | 普通 ESM module，`src/lib/**`                                     | **没有 IoC、没有装饰器**。直接 `import` 函数。Service 就是一个文件里 `export` 出来的函数。                                        |
| Midway Configuration      | `src/env.ts` (Zod 校验) + `next.config.mjs`                       | 所有 env 必须在 `env.ts` 中声明 schema，运行时类型安全。                                                                          |
| TypeORM / Sequelize       | Prisma                                                            | Prisma Schema = 数据建模 + 迁移 + 类型生成三合一。学完 §4.4 即可。                                                                |
| `@midwayjs/cron`          | `src/services/jobs/`（自研）+ `/api/jobs/tick`                    | 见 §4.7。我们没用 BullMQ，而是用 Postgres 做队列。                                                                                |
| `winston` / `egg-logger`  | `pino`（`src/lib/logger.ts`）                                     | API 几乎一样，少烦恼。                                                                                                            |
| Vite + Vitest             | Next.js 内置 webpack/turbopack + Vitest + Playwright              | 单测 Vitest 沿用熟悉的 API；E2E 用 Playwright（与 Cypress 思路相似）。                                                            |
| `Egg.js` 中间件           | Route Handler 内手动 compose / `src/lib/api-auth.ts` 这类高阶函数 | 没有"洋葱模型"，需要的横切能力以**函数包装**的形式手写。                                                                          |

> 一句话总结：**Vue → React** 主要要把"响应式"换成"重渲染 + 显式 state"；**Midway → Next.js** 主要要把"装饰器 + IoC"换成"普通模块 + 文件即路由"。其他 90% 的工程实践（TS、ESLint、Prettier、husky、CI）跟你之前的项目几乎一样。

---

## 2 · React 18 必学清单（按重要度降序）

只需要会下面这些，就能在本仓库里做 90% 的工作。**强烈建议先读官方 react.dev 的 "Learn" 章节**（4–6 小时即可），下面只列重点和易错点。

1. **JSX 语法 & 列表渲染**——`{items.map(it => <Row key={it.id} ... />)}`，`key` 不能省。
2. **组件 = 纯函数**——同样的 props 应该产出同样的 UI。副作用一律塞进 `useEffect` 或事件回调。
3. **Hook 规则**——只能在组件顶层调用，不能写在 `if` / `for` 里面，不能在普通函数里调用（自定义 Hook 名必须 `use*` 开头）。
4. **`useState` vs `useRef`**——`useState` 触发重渲，`useRef` 不触发；当你想保存 DOM 节点或"不参与渲染的可变值"用 ref。
5. **`useEffect` 的清理函数**——返回的函数会在依赖变化或卸载时跑，用来取消订阅/计时器。**等价于 Vue 的 `onBeforeUnmount` + `watch` 旧值清理**。
6. **`useMemo` / `useCallback`**——不是性能万金油。**只在子组件用 `React.memo` 或者 deps 真的很贵时才用**，滥用反而增加维护成本。
7. **Context**——本项目里只用来传 session、theme、toast，不要用 Context 做"全局状态管理"。
8. **Suspense**——`loading.tsx`、`<Suspense fallback={...}>` 都是它。Server Component 可以 `await` 数据，外层 Suspense 就会显示 fallback。
9. **Server Component vs Client Component**——见 §3，本项目最重要的概念。
10. **`react-hook-form` + `zod`**——表单全部用这套，不要自己写受控表单。`@hookform/resolvers/zod` 把 zod schema 直接接到 RHF。

> ⚠️ Vue 圈来的同学最容易写错的两个地方：
>
> 1. 把 `useState` 当 `reactive` 改：`state.count++` **完全无效**，必须 `setCount(c => c + 1)`。
> 2. 把 `useEffect` 当 `computed` 用：派生数据请用 `useMemo` 或者直接在 render 里算，**不要**在 effect 里 `setState`，会无限循环。

---

## 3 · Next.js App Router 心智模型

App Router 是本仓库最核心的概念。**没搞懂这个之前，请不要下手改路由相关代码。**

### 3.1 文件即路由

```
src/app/[locale]/(dashboard)/settings/security/page.tsx
        └─ 动态段     └─ 路由组    └─ 普通段    └─ 页面文件
```

- `[xxx]` = 动态段（等价于 Vue Router 的 `:xxx`）
- `(xxx)` = **路由组**（不影响 URL，只用来共享布局或分组）
- `page.tsx` = 该路径的页面入口
- `layout.tsx` = 该路径**及其子路径**共享的布局（嵌套布局，外层不卸载）
- `loading.tsx` = 该路径加载中的 Suspense fallback
- `error.tsx` = 该路径的 error boundary（必须是 Client Component）
- `not-found.tsx` = 404 页

URL `/<locale>/settings/security` 对应的渲染顺序是：

```
[locale]/layout.tsx → (dashboard)/layout.tsx → settings/layout.tsx? → security/page.tsx
```

### 3.2 Server Component vs Client Component（最重要的认知刷新）

|            | Server Component（默认）                     | Client Component (`'use client'`)             |
| ---------- | -------------------------------------------- | --------------------------------------------- |
| 在哪运行   | 只在服务器跑                                 | 服务器先 SSR，再到浏览器 hydrate              |
| 能做什么   | `async/await`、读 DB、读环境变量、读 cookies | 用户交互、`useState`、`useEffect`、浏览器 API |
| 不能做什么 | `useState`、事件监听、`window`               | 直接读 DB、用 server-only env                 |
| 作用       | 减少 bundle、安全访问后端                    | 交互、动效                                    |

**判断准则**：默认写 Server Component。**只有当这个组件需要 state / effect / 事件监听 / 浏览器 API 时**，才在文件顶部加 `'use client'`。

把 client 组件包在 server 组件里是允许的；反过来**不能**——如果一个 client 组件需要嵌入 server 组件，把 server 组件作为 `children` 或 `prop` 传进去。

> 类比：你可以把 Server Component 当成"在服务器上运行的 Midway Controller，但它的返回值是 React 节点而不是 JSON"。它**直接** `import` `prisma` 跑查询，不需要再开 HTTP。

### 3.3 数据获取的三种姿势

| 场景                  | 推荐方案                            | 例子                             |
| --------------------- | ----------------------------------- | -------------------------------- |
| 页面初次渲染所需数据  | **Server Component 内直接 `await`** | `const user = await getUser(id)` |
| 用户提交表单 / 改数据 | **Server Action**（`'use server'`） | `<form action={updateProfile}>`  |
| 第三方系统调你的 API  | **Route Handler** (`route.ts`)      | `src/app/api/v1/orgs/route.ts`   |

**不要**在 Server Component 里 `fetch('/api/...')` 自家 API——直接调 service 层函数。HTTP 是给外部客户端用的。

### 3.4 中间件（`src/middleware.ts`）

只做三件事：

1. 通过 `next-intl` 处理 locale 前缀和重写
2. 对 `/api/*` 透传，不走 i18n
3. 部分路径的早期重定向（比如未登录跳 `/login`）

**深度的鉴权和 RBAC 不放中间件**——它跑在 Edge runtime，能力受限，且每个请求都跑（性能开销）。鉴权放在页面/Action/Route Handler 里通过 `await auth()` 完成。

---

## 4 · 各模块设计理论

每个模块都按"它解决什么问题 → 关键文件 → 设计权衡 → 你接 issue 之前必须知道的事"四段写。

### 4.1 多区域（`src/lib/region.ts` + `prisma/schema.prisma` 的 `Region` 枚举）

**问题**：海外（`GLOBAL`）+ 国内（`CN`）+ 欧洲（`EU`）三套部署，数据不能跨境，但代码必须共享。

**设计**：每个 Kitora 进程**整个生命周期只跑在一个 region**，由 `KITORA_REGION` 环境变量决定。读取这个值的**唯一入口**是 `currentRegion()`——禁止直接 `process.env.KITORA_REGION`，因为：

- 大小写需要兜底（旧的 `REGION=cn` 还要兼容一段时间）
- 进程启动时跑一次 `region-startup-check.ts` 做合法性校验
- 测试里要能 mock

每张租户表都带 `region` 列，不是为了运行时分片（同一个进程只见自己 region 的数据），而是为了：

- 单条迁移可以把历史行 backfill 成 `GLOBAL`
- 取证 / 审计 SQL 可以直接按列过滤

**跨区域只走 HTTP**——比如 GLOBAL 给 CN 推 webhook。**不要**尝试连对方的数据库。

### 4.2 鉴权（`src/lib/auth/` + Auth.js / NextAuth v5）

**问题**：邮箱密码 + OAuth + WebAuthn + 2FA + SSO 全都要支持。

**关键文件**：

- `src/lib/auth/config.ts` — Auth.js 的中央配置（providers、callbacks、session 策略）
- `src/lib/auth/session.ts` — `auth()` 包装，所有页面/Action 通过它拿当前用户
- `src/lib/auth/2fa-totp.ts` + `2fa-crypto.ts` — TOTP 密钥的加密存储（**密钥永不明文落库**）
- `src/lib/auth/tokens.ts` — 一次性 token（验证邮箱、重置密码、邀请）
- `src/lib/auth/device-session.ts` — 记 device 指纹用于"在所有设备登出"

**设计权衡**：

- **JWT 而非 DB session**——但 `User.sessionVersion` 字段允许"全局踢人"。改密码 / 删账户 → bump 这个字段 → JWT 自带的版本不匹配 → 强制重新登录。这是 RFC 0002 的核心。
- **2FA 状态用单独的小 cookie + DB 标记双校验**——见 `two-factor-state.ts`。
- **不在中间件做 RBAC**——理由见 §3.4。每个 API route 第一行 `await requireSession(...)`。

**接 issue 前必须知道的**：

- 所有需要登录的页面，第一行 `const session = await auth(); if (!session) redirect('/login')`，或者用现成的 wrapper。
- 所有写操作要校验"该用户对该 org 有权限"，统一走 `src/lib/api-org-gate.ts`。

### 4.3 SSO 与 SCIM（`src/services/sso/` + `src/app/api/scim/v2/`）

**问题**：B2B 客户的 IT 部门要求"我的员工不在你的系统里建账号，从我的 IdP 直接 push 过来"。

**设计**：

- SSO 用 [`@boxyhq/saml-jackson`](https://boxyhq.com/docs/jackson/overview)，同时支持 SAML 2.0 和 OIDC。`/api/auth/sso/start` 启动握手，`/api/auth/sso/callback` 收回调，回调里把 IdP 用户和本地 User 表 link/auto-provision。
- SCIM v2 是 IETF 标准，IdP（Okta / Azure AD）通过它**主动**调用 `/api/scim/v2/Users` 增删改查。我们没自己造轮子，schema 严格按 RFC 7643。
- 每个 SCIM endpoint 单独鉴权（Bearer token，**不**走 NextAuth session），见 `src/lib/api-auth.ts`。

**陷阱**：SCIM 的 `PATCH` 用的是 RFC 6902 的 patch operations，不是 JSON Merge Patch。别想当然。

### 4.4 数据层（`prisma/` + `src/lib/db.ts`）

**问题**：类型安全 + 跨数据库可移植 + 迁移可审计。

**关键点**：

- `prisma/schema.prisma` 是单一事实源。**任何字段变更都要走 `pnpm db:migrate`**，**禁止手写 SQL** 改库。
- `src/lib/db.ts` 暴露**全局单例** `prisma`。Next.js dev 模式 HMR 会重建模块，所以单例挂在 `globalThis` 上避免连接泄漏。
- 注意 Prisma 在 Edge runtime 不可用——所以中间件不能直接 query。
- 软删 / 审计字段统一在 schema 里设计（`createdAt`、`updatedAt`、有时候 `deletedAt`）。

**Vue/Midway 圈的人最容易踩的坑**：Prisma `findUnique` 不是"查不到给 null"，**字段值传错类型直接抛**——Zod 校验请放到调用 Prisma 之前。

### 4.5 国际化（`src/i18n/` + `next-intl`）

**问题**：URL 要带 locale 前缀（`/zh/...` `/en/...`）；服务端组件、客户端组件、邮件模板都要能拿到翻译；翻译文件要能给非工程师维护。

**设计**：

- `src/i18n/routing.ts` 声明支持的 locales 和默认 locale
- `src/i18n/request.ts` 是 next-intl 的 server-side hook
- `messages/{locale}/*.json` 是翻译资源，按 namespace 分文件
- 服务端用 `getTranslations('namespace')`，客户端用 `useTranslations('namespace')`
- 邮件模板里用 `getTranslations` + 显式传 `locale`，不要假设当前请求

**ICP / 公安备案**只在 `KITORA_REGION=CN` 且 `ICP_NUMBER` 非空时渲染（见 marketing 区的 `icp/` 路由），这是合规硬要求。

### 4.6 计费（`src/services/billing/` + `src/lib/stripe/`）

**问题**：海外用 Stripe，国内用支付宝 + 微信支付，且要能 A/B 切换价格、处理订阅升降级。

**设计**：

- `src/services/billing/provider/types.ts` 定义统一接口 `BillingProvider`（`createCheckout`、`createPortal`、`handleWebhook` 等）
- `stripe.ts` / `alipay.ts` / `wechat.ts` 各自实现这个接口
- `src/services/billing/current.ts` 根据当前 region 选择 provider——**不在业务代码里 if region**
- Webhook 处理器**幂等**——所有 provider event 都先写入 `StripeEvent`（或对应表）做去重

**陷阱**：

- 中国大陆的支付回调是**服务端推**而不是浏览器跳转，所以 `/api/billing/alipay/notify` 必须公网可达且能验签。
- Stripe webhook 一定要校验 `Stripe-Signature` header，否则任何人都能伪造订阅生效。

### 4.7 后台任务系统（`src/services/jobs/`）

**问题**：发邮件、生成导出、清理过期 token 这类"用户请求时不想等"的活儿。

**设计选择**——**没用 BullMQ / Bee-Queue**，因为：

- Vercel / Serverless 上没法常驻 Worker 进程
- 不想多引入 Redis 作为任务存储（Redis 这里只用作 ratelimit）
- 我们的任务量级（单租户 < 1k/h）够用 Postgres

实现方式：

- `src/services/jobs/define.ts` 注册 job handler
- `src/services/jobs/enqueue.ts` 入队（写一行 `Job` 表）
- `src/services/jobs/runner.ts` 出队执行
- `src/app/api/jobs/tick` 是一个**外部 cron**（Vercel Cron / 阿里云定时触发器）每分钟打的 endpoint，每次拉一批 due job 执行
- `src/services/jobs/retry.ts` 里有指数退避策略
- `observability.ts` 把每次执行的状态写到日志和 Sentry

**接 issue 前必须知道**：handler 必须**幂等**，因为 cron 多实例 / 重试可能会让同一 job 跑两次。

### 4.8 邮件（`src/lib/email/` + `src/emails/` + Resend / Aliyun DM）

**问题**：用 React 写邮件模板（react-email），发送渠道按 region 切换。

**设计**：

- `src/emails/*.tsx` 是 react-email 模板，本质是 React 组件，运行时编译成 HTML
- 发送层抽象在 `src/lib/email/`，根据 region 调 Resend (GLOBAL/EU) 或 Aliyun DirectMail (CN)
- 所有发邮件**必须经过 `src/lib/email/`**，禁止业务代码直接调 Resend SDK
- 模板渲染时显式传 `locale`，**不要**依赖 next-intl 的 request scope

本地开发用 `pnpm email:dev` 起一个 react-email 预览服务（localhost:3001）。

### 4.9 存储（`src/lib/storage/`）

**问题**：用户上传头像/导出文件，海外存 S3-兼容（默认 AWS S3 / R2），国内存阿里云 OSS。

**设计**同 §4.6——`storage/` 下定义统一接口，按 region 选实现。**任何业务代码不要写 `new S3Client()`**——通过 `getStorage()` 拿。

### 4.10 速率限制（`src/lib/rate-limit.ts` + Upstash Redis）

**问题**：登录、忘记密码、注册等高敏感 endpoint 必须有节流，防爆破。

**设计**：

- 用 `@upstash/ratelimit`（slide window）
- key 由"endpoint 名 + 用户标识（IP / userId）"拼成
- 没设 Upstash 凭证时**降级为 no-op**（dev 环境无痛）

**接 issue 前必须知道**：写新的敏感 endpoint **默认就要套 rate limit**。

### 4.11 可观测（`src/lib/logger.ts` + Sentry + `analytics.ts`）

- 日志：`pino`，结构化 JSON 输出。**禁止 `console.log`**，连 dev 环境也用 logger。
- 错误监控：`@sentry/nextjs` 已经在 `sentry.*.config.ts` 配好。Server Action / Route Handler 抛出的异常自动捕获。
- 前端打点：`src/lib/analytics.ts` 抽象层，本地用 noop，生产端可以接 PostHog / Plausible。

### 4.12 OpenAPI（`openapi/v1.yaml` + `src/app/api/openapi/v1.yaml/route.ts`）

**问题**：对外开放的 `/api/v1/*` 必须有契约，给客户写 SDK / 给 Scalar 渲染交互文档。

**设计**：

- 单一 YAML 源（手写，不自动生成——保证文档表述比代码精确）
- `scripts/check-openapi-coverage.ts` 在 CI 检查"实现的 endpoint 是否都在 spec 里"
- `/<locale>/docs/api` 用 `@scalar/api-reference-react` 渲染交互式文档

如果你新增 `/api/v1/*` route，**必须同步改 `openapi/v1.yaml`**，否则 CI 红。

---

## 5 · 第一周路线图

> 假设你周一入职。每天 4–6 小时投入。

**Day 1 — 跑起来**

- 阅读 `README.md`、本文档 §1 ~ §3
- 按 README 配 `.env.local`、起 Postgres、`pnpm db:migrate`、`pnpm dev`
- 在浏览器里点完所有页面，对照 §3.1 的路由结构

**Day 2 — React/Next 基础**

- 读 [react.dev "Learn"](https://react.dev/learn) 前半（到 Effects）
- 读 [Next.js App Router 文档](https://nextjs.org/docs/app) 的 Routing + Data Fetching
- 把项目里**任意一个**Server Component 改成 Client Component 然后看报错（理解为什么不能）

**Day 3 — 数据流 & Auth**

- 读 §4.2、§4.4
- `pnpm db:studio` 看数据表
- 在本地注册一个账号、走完邮箱验证、绑定 2FA

**Day 4 — 业务模块挑一个深读**

- Billing / Jobs / SSO 任选一个，完整读对应 `src/lib/<模块>` + `src/app/api/<模块>` + 相关测试
- 写一段 200 字的笔记给自己（"它解决什么问题、关键抽象是什么、有什么坑"）

**Day 5 — 第一个 PR**

- 从 issue 列表里挑 `good-first-issue` 标签
- 严格遵守：
  - 改完 `pnpm typecheck && pnpm lint && pnpm test:unit` 全绿
  - 涉及 schema → `pnpm db:migrate`
  - 涉及 `/api/v1/*` → 同步改 `openapi/v1.yaml`
  - commit 走 conventional commits（`feat:` / `fix:` / `refactor:` ...）

**第二周开始**：可以认领正常 issue。建议先碰 marketing 页 / dashboard 页这类纯前端任务，再下沉到 lib 层。

---

## 6 · 反模式速查表（高频踩坑）

| 别这么写                                                         | 为什么                               | 应该怎么写                                        |
| ---------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------- |
| 在 Server Component 里 `fetch('/api/...')` 自家 API              | 多一跳网络 + 失去类型 + 可能死锁     | 直接 `import` service 层函数                      |
| 改 `useState` 的对象/数组：`state.list.push(x); setState(state)` | 引用没变，React 不重渲               | `setState(s => ({ ...s, list: [...s.list, x] }))` |
| 直接 `process.env.KITORA_REGION`                                 | 大小写、合法值、测试 mock 都会出问题 | `currentRegion()`                                 |
| `console.log` 调试                                               | 生产日志噪音 + 没有结构化字段        | `logger.info({ orgId }, 'message')`               |
| 业务代码里 `if (region === 'CN')` 切支付                         | 重复 + 易漏                          | 通过 `getBillingProvider()` 拿当前 provider       |
| 在中间件里查 DB 做权限判断                                       | Edge runtime 不支持 Prisma + 性能差  | 在页面/Action 里 `await auth()`                   |
| 手写 SQL migrate                                                 | 与 Prisma schema 漂移                | `prisma migrate dev --name <desc>`                |
| 把翻译字符串硬编码成中文                                         | 国际化失败                           | 用 `useTranslations` / `getTranslations`          |
| Server Action 里不做 zod 校验直接调 Prisma                       | 任何前端表单都能伪造 payload         | `const data = Schema.parse(formData)`             |
| 新加 `/api/v1/*` 不改 openapi                                    | CI 直接红                            | 同步改 `openapi/v1.yaml`                          |

---

## 7 · 推荐资料（按性价比）

- **必读**：[react.dev "Learn"](https://react.dev/learn) — 官方 tutorial，4 小时搞定。
- **必读**：[Next.js App Router 文档](https://nextjs.org/docs/app) — 重点是 Routing、Rendering、Data Fetching、Server Actions 这四章。
- **必读**：[Prisma docs · CRUD](https://www.prisma.io/docs/orm/prisma-client/queries/crud) — 半小时翻完。
- **进阶**：[Auth.js v5 docs](https://authjs.dev) — 接 SSO / WebAuthn 的时候再看。
- **进阶**：[next-intl docs](https://next-intl-docs.vercel.app) — 加新语言的时候再看。
- **闲时**：Dan Abramov 的 [Overreacted](https://overreacted.io) — 想真正搞懂"为什么 React 这样设计"。

---

## 8 · 求助路径

- 项目内 RFC：`docs/rfcs/` — 重大架构决策都有 RFC 编号（RFC 0002 = 鉴权，RFC 0005 = 多区域，等）。看代码先翻 RFC 是省时间的捷径。
- 部署文档：`docs/deploy/`
- 项目 Slack（或团队约定的频道）：先 grep 历史聊天，再问。
- 实在卡住 → 找你的入职 mentor pair，**不要超过 1 小时独自卡死**。

---

> 维护者注：本文档每次大版本（package.json `version` 升 minor）应回顾一次。新增模块时，§4 加一节，§6 加对应反模式。
