# CLAUDE.md — AI 协作契约

> 这份文档是 Claude Code、Cowork、Claude Design 等 AI 工具进入本项目时的共享上下文。每次对话开始前都会被读取一次，请保持精炼，长篇内容用引用方式指向 `docs/` 下的对应文件。

---

## 1. 项目身份

- **名称：** Kitora
- **定位：** 生产级 Next.js SaaS 启动框架。初期面向海外市场，中期支持中国地区。
- **形态：** Multi-region share-nothing 部署（GLOBAL / CN / EU），通过 `KITORA_REGION` 环境变量切换身份；详见 [README](./README.md) 和 [RFC 0005](./docs/rfcs/0005-data-residency.md)。
- **当前阶段：** 孵化期，业务垂直方向待定，UI 视为可特化的中性底座。

## 2. 技术栈速览

Next.js 14（App Router）· TypeScript（strict）· Tailwind 3.4 + shadcn/ui · PostgreSQL + Prisma · Auth.js v5 + WebAuthn · BoxyHQ saml-jackson（SAML / OIDC + SCIM）· next-intl（en / zh）· Stripe + Alipay + WechatPay · Resend + Aliyun DM · Upstash Redis · Sentry + pino · Vitest + Playwright · pnpm 10.x · Node 22.x。

完整版本号见 [`package.json`](./package.json)。

## 3. 设计系统（重要）

**所有 UI 设计与代码必须遵循同一套设计契约。** 设计契约的权威源是：

📐 **[`docs/design/claude-design-getting-started.md`](./docs/design/claude-design-getting-started.md)**

这份文档同时承担两个角色：

1. **AI 设计输入：** 在 [claude.ai/design](https://claude.ai/design) 创建项目时整段粘贴，作为 Onboarding brief。
2. **代码实现规范：** Claude Code / Cowork 在生成或修改 UI 代码时必须读取并遵守。

核心约束摘要（详细见上方文档）：

- **整体调性：** Apple / Arc Browser 风 —— 精确、克制、高级。
- **颜色系统：** 全部走 HSL CSS variables，定义在 `src/app/globals.css`，由 `tailwind.config.ts` 消费。**禁止硬编码 hex 值**，一律引用 token 名（`bg-background`、`text-foreground`、`border-border` 等）。
- **明暗主题：** 通过 `<html>` 上的 `class="dark"` 切换，由 `next-themes` 管理，默认跟随 System。所有页面必须双主题可用。
- **品牌主色：** 当前未确定，由 Claude Design 提案；提案确定后须同步更新 `globals.css` 与本文档。
- **组件库：** 优先组合现有 shadcn/ui primitives（Avatar / Dialog / Dropdown Menu / Label / Slot / Toast）。新组件遵循 `class-variance-authority` (cva) 变体模式。
- **国际化：** UI 文案一律 key 化，走 `next-intl`。设计与实现都要为 30% 文字宽度膨胀留余量。

任何设计令牌（颜色、字号、圆角、间距、动画时长）的调整都需同步三处：`globals.css` ↔ `tailwind.config.ts` ↔ `docs/design/claude-design-getting-started.md`。

## 4. 区域感知（Region-Aware）

代码中读 region 永远走 `currentRegion()`（`src/lib/region.ts`）。
第三方 provider 永远走 `src/lib/region/providers.ts` 的 factory。

不同 region 的 provider 矩阵：

| 能力     | GLOBAL  | CN                     | EU      |
| -------- | ------- | ---------------------- | ------- |
| 支付     | Stripe  | Alipay + WechatPay     | Stripe  |
| 邮件     | Resend  | Aliyun DirectMail      | Resend  |
| 对象存储 | S3      | Aliyun OSS             | S3      |
| Redis    | Upstash | Aliyun Redis (ioredis) | Upstash |

新增 provider 时务必走 factory 模式，不要在业务代码里直接 `import` 任何区域绑定的 SDK。

## 5. 代码约束

- **包管理器：** 仅使用 `pnpm`（10.33+）。禁止 `npm` / `yarn`。
- **Node 版本：** 22.x。
- **类型：** 一律 TypeScript strict。运行时校验用 `zod`，不要依赖 TS 类型作为运行时保证。
- **目录：**
  - `src/app/` — App Router 路由与页面
  - `src/components/` — 可复用 UI 组件
  - `src/lib/` — 业务无关的工具与 provider 工厂
  - `src/emails/` — React Email 模板（开发用 `pnpm email:dev`）
  - `prisma/` — Schema 与 seed
  - `docs/` — 设计、部署、RFC、上手指南
- **命名：**
  - 文件：`kebab-case.ts`
  - React 组件：`PascalCase.tsx`
  - 工具函数：`camelCase`
  - 数据库表：`snake_case`（已由 Prisma `@@map` 处理）
- **CSS：** 仅用 Tailwind utilities + 设计系统 token。禁止内联 `style={{ color: '#xxxxxx' }}`。
- **客户端边界：** 默认 server component；需要交互时再加 `'use client'`，并尽量收敛到叶子节点。

## 6. 测试与质量

- **单测：** Vitest（`pnpm test:unit`）。
- **E2E：** Playwright（`pnpm test:e2e`）。
- **类型检查：** `pnpm typecheck`。
- **Lint：** `pnpm lint`。
- **格式化：** Prettier + prettier-plugin-tailwindcss。
- **OpenAPI：** `pnpm openapi:lint` 校验、`pnpm openapi:check` 检查路由覆盖。

提交前必过：`typecheck` + `lint` + `test:unit`。E2E 由 CI 跑。

## 7. RFC 索引（架构决策的权威源）

| 编号                                                 | 主题                          |
| ---------------------------------------------------- | ----------------------------- |
| [RFC 0001](./docs/rfcs/0001-organizations.md)        | Organizations 多租户          |
| [RFC 0002](./docs/rfcs/0002-security-compliance.md)  | 安全与合规基线                |
| [RFC 0003](./docs/rfcs/0003-webhooks-and-openapi.md) | Webhooks 与 OpenAPI           |
| [RFC 0004](./docs/rfcs/0004-sso.md)                  | SSO（SAML / OIDC + SCIM）     |
| [RFC 0005](./docs/rfcs/0005-data-residency.md)       | Data Residency / Multi-region |
| [RFC 0006](./docs/rfcs/0006-cn-region-deployment.md) | CN 区域部署                   |
| [RFC 0007](./docs/rfcs/0007-webauthn-passkey.md)     | WebAuthn / Passkey            |
| [RFC 0008](./docs/rfcs/0008-background-jobs.md)      | 后台任务系统                  |

涉及任何架构层面的变更，**先读相关 RFC**，必要时新增 RFC 而非直接改实现。

## 8. 与 AI 协作的偏好

- **沟通语言：** 中文优先；专业术语保留英文（如 token、component、accent、breakpoint、empty state、skeleton 等）。
- **回答长度：** 偏简洁，但关键决策需说清楚 trade-off。
- **不要做：**
  - 在没有读 RFC 的情况下做架构性变更
  - 硬编码颜色 / 字号
  - 在业务代码里直接 import region-bound 的 SDK
  - 用 `npm` / `yarn` 发命令
- **要做：**
  - 修改前先读相关现有代码
  - UI 任务先看设计契约（第 3 节）
  - 给出方案时附上影响面（哪些文件、哪些 region、是否动 schema）
