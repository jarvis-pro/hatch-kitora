# Kitora — Claude Design 上手指南

> 这份文档用于在 [claude.ai/design](https://claude.ai/design) 首次进入项目时，作为初始化输入提供给 Claude Design。它会读取这份 brief 自动建立项目的设计系统，使后续所有设计稿自动遵循同一套规范。
>
> **使用方式：** 创建新项目 → 在 "Tell Claude about your project" 区域，整段粘贴本文档"粘贴起点"以下、"粘贴终点"以上的全部内容。

---

## 粘贴起点 ⬇

# Project: Kitora

一个使用 Next.js 构建的、面向全球市场的生产级 SaaS Starter。技术栈成熟且做了明确取舍；业务垂直方向有意保持中性，便于后续特化。

## 1. 产品定位

- **类型：** 多租户 SaaS Starter / 框架。垂直方向待定，把 UI 当作中性底座，让任何 B2B / ProSumer SaaS 都能在此基础上特化。
- **主要市场：** 全球英文用户（北美、欧洲、亚太）。
- **次要市场：** 中国大陆（Phase 2）。本地化的支付、邮件、对象存储已在代码层接好。
- **目标用户：** 创业者、独立开发者、小型产品团队，以及偏开发者属性的 SaaS 用户。技术素养中到高。

## 2. 调性与视觉方向

整体追求 **Apple / Arc Browser** 风格 —— 精确、克制、高级。界面要让人感到是手工打磨过的，而不是从模板里冲压出来的。

具体要点：

- **充分留白。** 呼吸感是产品力的一部分，不是浪费。
- **克制配色。** 一根中性色脊柱 + 一个有表达力的 accent 色，禁止彩虹堆砌。
- **微妙的层次。** 柔和阴影、frosted-glass 表面（`backdrop-filter: blur`）、hero 区域可用温和渐变 —— 但绝不刺眼。
- **精致的微交互。** Hover lift、focus glow、accordion reveal、toast 提示都要有手工感。
- **清爽的字体层级。** 标题段紧字距、正文段宽行距、对比强但不喧哗。
- **优先使用摄影质感 / 抽象渐变 hero**，避免扁平插画或卡通吉祥物。
- **Dark mode 是一等公民**，不是附加项。深色面用接近黑的 `hsl(240 10% 3.9%)`，禁止纯 `#000`。

应避免：粗边框、主色泛滥、卡通插画、超大圆角、倾斜阴影、霓虹光晕、emoji 滥用。

## 3. 设计系统（已锁定的基线）

代码库里已经接好了 shadcn/ui + Tailwind 的设计系统底座。在生成组件时请**严格遵守这些 token** —— 它们已经一路连到生产环境的 CSS 变量。

### 3.1 Color Tokens（HSL CSS variables）

Token 定义在 `src/app/globals.css` 中，由 `tailwind.config.ts` 消费。两套主题共享同一组 token 名称，仅 value 不同。

#### Light theme（`:root`）

| Token                      | HSL              | Hex (近似) | 用途                 |
| -------------------------- | ---------------- | ---------- | -------------------- |
| `--background`             | `0 0% 100%`      | `#FFFFFF`  | 页面底色             |
| `--foreground`             | `240 10% 3.9%`   | `#09090B`  | 正文文字             |
| `--card`                   | `0 0% 100%`      | `#FFFFFF`  | Card 表面            |
| `--card-foreground`        | `240 10% 3.9%`   | `#09090B`  | Card 上的文字        |
| `--popover`                | `0 0% 100%`      | `#FFFFFF`  | Popover / Menu 表面  |
| `--popover-foreground`     | `240 10% 3.9%`   | `#09090B`  | Popover 内文字       |
| `--primary`                | `240 5.9% 10%`   | `#18181B`  | 主操作               |
| `--primary-foreground`     | `0 0% 98%`       | `#FAFAFA`  | 主操作上的文字       |
| `--secondary`              | `240 4.8% 95.9%` | `#F4F4F5`  | 次级表面             |
| `--secondary-foreground`   | `240 5.9% 10%`   | `#18181B`  | 次级表面上的文字     |
| `--muted`                  | `240 4.8% 95.9%` | `#F4F4F5`  | 弱化表面             |
| `--muted-foreground`       | `240 3.8% 46.1%` | `#71717A`  | 弱化文字             |
| `--accent`                 | `240 4.8% 95.9%` | `#F4F4F5`  | Accent 表面（hover） |
| `--accent-foreground`      | `240 5.9% 10%`   | `#18181B`  | Accent 上的文字      |
| `--destructive`            | `0 84.2% 60.2%`  | `#EF4444`  | 危险操作             |
| `--destructive-foreground` | `0 0% 98%`       | `#FAFAFA`  | 危险操作上的文字     |
| `--border`                 | `240 5.9% 90%`   | `#E4E4E7`  | 边框、分隔线         |
| `--input`                  | `240 5.9% 90%`   | `#E4E4E7`  | 表单边框             |
| `--ring`                   | `240 5.9% 10%`   | `#18181B`  | Focus ring           |

#### Dark theme（`.dark`）

| Token                      | HSL              | Hex (近似) |
| -------------------------- | ---------------- | ---------- |
| `--background`             | `240 10% 3.9%`   | `#09090B`  |
| `--foreground`             | `0 0% 98%`       | `#FAFAFA`  |
| `--card`                   | `240 10% 3.9%`   | `#09090B`  |
| `--card-foreground`        | `0 0% 98%`       | `#FAFAFA`  |
| `--popover`                | `240 10% 3.9%`   | `#09090B`  |
| `--popover-foreground`     | `0 0% 98%`       | `#FAFAFA`  |
| `--primary`                | `0 0% 98%`       | `#FAFAFA`  |
| `--primary-foreground`     | `240 5.9% 10%`   | `#18181B`  |
| `--secondary`              | `240 3.7% 15.9%` | `#27272A`  |
| `--secondary-foreground`   | `0 0% 98%`       | `#FAFAFA`  |
| `--muted`                  | `240 3.7% 15.9%` | `#27272A`  |
| `--muted-foreground`       | `240 5% 64.9%`   | `#A1A1AA`  |
| `--accent`                 | `240 3.7% 15.9%` | `#27272A`  |
| `--accent-foreground`      | `0 0% 98%`       | `#FAFAFA`  |
| `--destructive`            | `0 62.8% 30.6%`  | `#7F1D1D`  |
| `--destructive-foreground` | `0 0% 98%`       | `#FAFAFA`  |
| `--border`                 | `240 3.7% 15.9%` | `#27272A`  |
| `--input`                  | `240 3.7% 15.9%` | `#27272A`  |
| `--ring`                   | `240 4.9% 83.9%` | `#D4D4D8`  |

### 3.2 品牌色 — 待提案

品牌主色目前**未确定**。请基于 Apple / Arc 调性，提出 2–3 个能在双主题下都成立的 accent 候选色。建议方向：

- 偏冷的科技紫（如 `260 60% 55%`），传达现代 / AI-adjacent 气质。
- 自信的青蓝（如 `190 70% 45%`），传达可信赖、冷静的 SaaS 气质。
- 暖色日出渐变（橙 → 粉），仅用于 marketing 表面。

生成 marketing 页面时，可以引入 hero 渐变；生成 dashboard 时**保持中性** —— accent 色仅出现在主 CTA、focus 状态、active nav 项上。

### 3.3 Typography

- **Sans（UI + 正文）：** `--font-sans`，由 `next/font` 在 `src/app/layout.tsx` 中绑定。设计稿默认使用 **Inter** 或 **Geist Sans** 预览。Phase 2 中文本地化要求 CJK fallback（Noto Sans SC / PingFang SC）。
- **Mono（代码、ID）：** `--font-mono`。默认使用 **Geist Mono** 或 **JetBrains Mono**。

字号阶梯（建议值，未特别说明则遵循 shadcn 默认）：

| 角色            | 字号    | Weight | Line-height | Tracking |
| --------------- | ------- | ------ | ----------- | -------- |
| Display（hero） | 56–72px | 600    | 1.05        | -0.02em  |
| H1              | 36–48px | 600    | 1.1         | -0.015em |
| H2              | 28–32px | 600    | 1.2         | -0.01em  |
| H3              | 20–24px | 600    | 1.3         | -0.005em |
| Body            | 16px    | 400    | 1.6         | 0        |
| Small           | 14px    | 400    | 1.5         | 0        |
| Caption         | 12px    | 500    | 1.4         | 0.02em   |

### 3.4 Layout & Shape

- **Container：** 居中，`padding: 2rem`，`2xl` 断点最大宽度 `1400px`。
- **Border radius：** 基准 `--radius: 0.5rem`。`lg = 0.5rem`、`md = 0.375rem`、`sm = 0.25rem`。Card 用 `lg`，Pill / Avatar 用 full。
- **栅格：** Desktop 12 列、Mobile 4 列。Gutter Desktop 24px、Mobile 16px。
- **断点：** sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1400。
- **Elevation：** 三档 —— flush、`shadow-sm`（轻量 hover）、`shadow-lg`（popover / modal）。不要新增更多。

### 3.5 Motion

- 默认缓动：`cubic-bezier(0.16, 1, 0.3, 1)`（带回弹的减速曲线）。
- 时长：150ms（hover）、200ms（accordion / dropdown）、300ms（页面过渡）。
- 必须尊重 `prefers-reduced-motion`。
- 已有 keyframes：`accordion-down` / `accordion-up`（200ms ease-out）。

## 4. 组件库

代码库使用 **shadcn/ui**（Radix primitives + Tailwind）。已安装：Avatar、Dialog、Dropdown Menu、Label、Slot、Toast。表单层使用 React Hook Form + Zod。Toast 使用 Sonner。图标使用 Lucide React。

设计新页面时**优先组合这些 primitives**，不要发明新模式。自定义组件应遵循同样的 `class-variance-authority`（cva）变体模式。

## 5. 国际化

- **i18n 方案：** `next-intl`。所有 UI 文案以 key 化方式管理。
- **默认语言：** `en`。Phase 2 增加 `zh-CN`。
- **布局影响：** 设计稿必须能容纳约 30% 的文字宽度膨胀。避免固定宽度按钮和紧贴边缘的标题。CTA 周围保留充分的呼吸空间。
- **日期 / 数字 / 货币：** 使用 locale-aware 格式化。货币在 USD（默认）和 CNY（中国地区）之间切换。

## 6. 主题切换

- 库：`next-themes`。策略：`<html>` 上的 `class`。
- 用户可选 Light / Dark / System。**首访默认 System**。
- 主题切换器位于已登录页面右上角，以及 marketing 页面 footer。
- 所有页面**必须同时呈现两种主题**并排展示。禁止硬编码 hex 值，一律引用上面的 token 名称。

## 7. MVP 页面优先级

请按以下顺序生成页面集：

### 7.1 Marketing 站（优先级 1）

- **Landing / Home：** 透明吸顶 nav、全屏 hero（柔和渐变 + 产品 mockup）、社会证明 logo wall、3-up feature grid、"How it works" 三步条带、testimonial 轮播、FAQ accordion、footer。
- **Pricing：** 三档卡片（Starter / Pro / Team）、月付/年付切换、特性对比矩阵、FAQ。
- **Features 详情页（模板）：** Hero + 双栏交错的 screenshot/text 区块 + CTA banner。
- **法律页：** Terms、Privacy、Cookies —— 长文阅读布局，带 TOC 侧栏。

### 7.2 认证（优先级 2）

- **Sign in：** 邮箱+密码、社交登录（Google、GitHub）、passkey（WebAuthn）、magic link 入口。
- **Sign up：** 与 Sign in 同一界面族，附加 org 创建步骤。
- **Onboarding：** 三步进度：profile → workspace → first action。
- **Verify email / Forgot password / Reset password。**
- **Two-factor / Passkey enrollment。**

### 7.3 已登录 App Shell + Dashboard（优先级 3）

- **App shell：** 左侧可折叠 nav（workspace switcher、主导航、次级导航），顶栏含面包屑、全局搜索、用户菜单、主题切换。Mobile 用 drawer nav。
- **Home dashboard：** 4 个 KPI tile → 最近活动流 + 快捷操作面板 → onboarding checklist（可折叠）。所有列表必须有 empty state。

### 7.4 账户与计费（优先级 4）

- **Settings 索引：** 子导航：Profile、Account、Security、Notifications、Appearance、API keys、Webhooks。
- **Billing：** 当前套餐卡片、用量进度、发票表格、支付方式（全球区用 Stripe，中国区用 Alipay / WechatPay —— 显示地区切换）。
- **Team：** 成员表格带角色 pill、邀请 dialog、待处理邀请列表、SSO 设置（SAML）、审计日志预览。
- **API keys & Webhooks：** 列表带 masked secret、create/rotate dialog、scope 选择器。

## 8. 设计的非功能性要求

- **无障碍：** WCAG 2.2 AA 对比度起步。所有可交互元素必须键盘可达。Focus ring 使用 `--ring`。
- **Empty state：** 每个列表/表格都必须有专门设计的 empty state，并提供主操作。
- **Loading state：** Dashboard 用 skeleton；按钮内反馈才用 spinner；避免全页 spinner。
- **Error state：** 表单错误用 inline + `--destructive` 红色；瞬时错误用 toast；致命错误用 404 / 500 全页。
- **信息密度：** 友好支持紧凑视图。数据密集型表格需提供 "comfortable / compact" 切换。
- **Mobile：** 每个页面都必须有 mobile 版本。认证和 onboarding 流程的 mobile 主 CTA 应固定在屏幕底部。

## 9. 技术栈快照（仅作背景）

Next.js 14.2（App Router）· React 18 · TypeScript · Tailwind 3.4 · shadcn/ui · next-themes · next-intl · NextAuth v5 · Prisma · @boxyhq/saml-jackson · WebAuthn（SimpleWebAuthn）· Stripe + Alipay + WechatPay · Resend + Aliyun DM · Upstash Redis · Sentry · Vitest + Playwright。

## 10. 交付格式要求

请按以下方式返回设计稿：

1. 画布按上面四个 MVP 页面集分组。
2. 每个页面**同时渲染 light 与 dark 两个主题**，并排呈现。
3. 当移动端布局与桌面端有显著差异时，提供并排的 mobile 版本。
4. 提供一个 "Design tokens" frame，总结你选定的品牌 accent 以及任何提议扩展的 token。
5. 在设计稿旁标注你对业务垂直方向所做的任何假设。

End of brief.

## 粘贴终点 ⬆

---

## 给你（Jarvis）的使用提示

- 首次进入 Claude Design 时，把"粘贴起点"以下到"粘贴终点"以上的内容**整段复制粘贴**到 onboarding 输入框。
- 进入 onboarding 后 Claude Design 会问几个补充问题，按它的引导走即可。
- 如果它给出的品牌色不满意，直接告诉它"换一个更冷调 / 暖调的"，它会重出方案。
- 后续做新页面时，开头一句话就够，比如"基于已建立的设计系统，画一个 API Keys 管理页"。
- 这份文档已纳入 git 跟踪，作为团队和 AI 共享的设计契约。后续 token 调整时同步更新这份文档，并在 `CLAUDE.md` 中保持引用一致。
