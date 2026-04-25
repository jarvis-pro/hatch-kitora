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

| 层级 | 技术选型 |
|---|---|
| 框架 | Next.js 14+（App Router） |
| 语言 | TypeScript |
| 样式 | Tailwind CSS |
| 数据库 | PostgreSQL + Prisma |
| 认证 | NextAuth.js |
| 支付 | Stripe |
| 邮件 | Resend |
| 部署 | Vercel |

---

## 🚀 快速开始

### 环境要求

- Node.js 18+
- pnpm（推荐）
- PostgreSQL 数据库

### 安装

```bash
# 克隆仓库
git clone https://github.com/your-username/kitora.git
cd kitora

# 安装依赖
pnpm install

# 复制环境变量文件
cp .env.example .env.local
```

### 环境变量

在 `.env.local` 中填入以下配置：

```env
# 应用
NEXT_PUBLIC_APP_URL=http://localhost:3000

# 数据库
DATABASE_URL=postgresql://user:password@localhost:5432/kitora

# 认证
NEXTAUTH_SECRET=your-secret
NEXTAUTH_URL=http://localhost:3000

# 支付
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# 邮件
RESEND_API_KEY=re_...
```

### 启动开发环境

```bash
# 执行数据库迁移
pnpm db:migrate

# 启动开发服务器
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000) 查看效果。

---

## 📁 项目结构

```
kitora/
├── app/                  # Next.js App Router
│   ├── (auth)/           # 认证页面（登录、注册）
│   ├── (dashboard)/      # 受保护的控制台页面
│   ├── (marketing)/      # 公开营销页面
│   └── api/              # API 路由
├── components/           # 公共 UI 组件
├── lib/                  # 工具函数与辅助模块
│   ├── auth/             # 认证配置
│   ├── db/               # 数据库客户端
│   └── email/            # 邮件模板
├── prisma/               # 数据库 Schema 与迁移文件
└── public/               # 静态资源
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
- [ ] 用户认证流程
- [ ] 订阅计费（Stripe）
- [ ] 用户控制台
- [ ] 管理后台
- [ ] 国际化 — 英语及其他语言
- [ ] 中国区支持（支付与基础设施）

---

## 🤝 参与贡献

目前为独立开发者项目，欢迎通过 GitHub Issues 提交问题或建议。

---

## 📄 开源协议

MIT © [你的名字]
