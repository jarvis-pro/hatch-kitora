# 体系化学习路线 · Vue + Midway → Kitora

> 与 [vue-to-nextjs.md](./vue-to-nextjs.md) 的关系：
>
> - **vue-to-nextjs.md** 是 1 ~ 2 周的速通手册，让你**能动手改 issue**；
> - **本文档**是 4 ~ 6 周的体系化路线，让你**能独立设计模块**。
>
> 两份不互斥——速通手册建议先读，再按本路线慢炖。

每周给你：①本周目标 ②要学的知识点 ③推荐外部资料 ④项目内必读的对应代码 ⑤周末自我验证题。每周预计投入 **15 ~ 20 小时**（按 4 ~ 6 小时/工作日）。

---

## Week 1 · React 18 基础 + Next.js App Router

**目标**：写得出 Server / Client Component，理解 App Router 的文件约定，能自己搭出"文章列表 + 详情页"这种最小 demo。

**知识点**

- JSX 语法、组件 = 纯函数、为什么 React 不是响应式系统
- Hook 规则与五大常用 Hook：`useState` / `useEffect` / `useMemo` / `useCallback` / `useRef`
- Server Component vs Client Component 的运行时差异
- App Router 的 `page.tsx` / `layout.tsx` / `loading.tsx` / `error.tsx` / `not-found.tsx`
- 动态段 `[id]` / 路由组 `(group)` / 并行路由 `@modal`（项目暂未用，知道概念即可）
- `Suspense` 与"流式渲染"

**推荐外部资料**

- [react.dev "Learn"](https://react.dev/learn) — 全部 14 章，**这是必读，没有捷径**
- [Next.js App Router Routing 章节](https://nextjs.org/docs/app/building-your-application/routing) — 1-2 小时
- 视频：Theo / Dan Abramov 的"How React Server Components work"演讲（B 站有搬运）

**项目内必读代码**

- `src/app/[locale]/layout.tsx` — 看最外层布局怎么注入 ThemeProvider / IntlProvider / SessionProvider
- `src/app/[locale]/(dashboard)/dashboard/page.tsx` — 一个典型的 Server Component 页面
- `src/app/[locale]/(auth)/login/page.tsx` 与配套的客户端表单 — 看 Server / Client 边界怎么切

**周末自我验证**

- ☐ 不查文档解释清楚：为什么 `error.tsx` 必须是 Client Component？
- ☐ 写一个本地 demo：服务端组件读 JSON 数据，客户端组件做"过滤搜索"
- ☐ 改一行 `useState` 的 setter，让自己亲眼看到对象赋值不重渲的现象

---

## Week 2 · TypeScript 进阶 + 项目工具链

**目标**：项目里的 ts 报错你能自己读懂，能配置和运行所有 lint / format / test 脚本。

**知识点**

- TS 进阶：`type` vs `interface`、泛型、`infer`、`Awaited`、`ReturnType`、模板字面量类型
- Zod 的 schema → infer 类型的双向流（项目里的 `env.ts` 是教科书例子）
- ESLint + Prettier + husky + lint-staged 的协作链路
- Vitest 单测、Playwright E2E 的差异和定位
- `pnpm` workspace 与 `pnpm` 严格依赖（与 npm 不同）

**推荐外部资料**

- [Total TypeScript "Beginner's Guide"](https://www.totaltypescript.com/beginners-typescript) — 免费章节够用
- [Zod docs](https://zod.dev) — 30 分钟翻完
- [Vitest 文档](https://vitest.dev) — API 跟 Jest 几乎一样

**项目内必读代码**

- `src/env.ts` — Zod 校验环境变量的范本
- `src/lib/auth/2fa-totp.ts` 配套的 `*.test.ts` — 看一个真实的单测怎么写
- `playwright.config.ts` + `tests/e2e/*` — 看 E2E 的 fixture 与 storageState 复用
- `package.json` 的 `scripts` 段——把每个命令都跑一遍

**周末自我验证**

- ☐ 读 `src/env.ts` 之后，自己加一个新 env 变量并让它在某个 lib 里被读到，**保证 TS 类型贯通**
- ☐ 给项目里任意一个 lib 函数补一个边界用例的单测
- ☐ 跑 `pnpm test:e2e:ui` 走通登录流程，自己在 trace viewer 里看一遍

---

## Week 3 · Server Actions + 数据流 + Prisma

**目标**：能独立给一个表单从前端到 DB 落库的完整链路。

**知识点**

- Server Actions 的 `'use server'` 声明、参数序列化限制（不能传函数 / class 实例）
- `useFormState` / `useFormStatus` 这些 React 18 的表单 Hook
- Prisma 的 `findUnique` / `findMany` / `update` / `transaction` / `$transaction` 互斥锁
- Optimistic update vs Server-driven UI 的取舍
- `revalidatePath` / `revalidateTag` 的缓存失效语义
- next-intl 在 Server Action 里怎么读 locale

**推荐外部资料**

- [Next.js Server Actions 章节](https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions-and-mutations)
- [Prisma · CRUD 章节](https://www.prisma.io/docs/orm/prisma-client/queries/crud) + [Filtering & Sorting](https://www.prisma.io/docs/orm/prisma-client/queries/filtering-and-sorting)
- 文章："The Server Action Architecture"（搜该名即可，2024 年的几篇分析都不错）

**项目内必读代码**

- `src/services/account/actions.ts`（或 `src/lib/auth/actions.ts`） — 一个完整的 Server Action 实现：Zod 校验 → 鉴权 → DB 操作 → revalidate → 返回 typed result
- `src/lib/api-org-gate.ts` — 跨多个 action 复用的"Org 权限闸门"
- `prisma/schema.prisma` 全文 — 这是项目里最重要的 1 个文件，至少完整读一遍

**周末自我验证**

- ☐ 自己加一个"修改用户昵称"的 server action，从 form 到 DB 全链路跑通
- ☐ 解释清楚：Server Action 的安全模型——为什么前端不能伪造调用？（提示：CSRF + Action ID）
- ☐ 在 Prisma Studio 里改一行数据，观察 `revalidatePath` 是否真的让页面拿到最新值

---

## Week 4 · 鉴权与会话（Auth.js v5）

**目标**：能讲清楚一次登录请求从浏览器到 cookie 落地的全流程，能给 SSO / 2FA 改 bug。

**知识点**

- JWT 与 DB session 的取舍、`sessionVersion` 字段的"全局踢人"机制
- Auth.js providers 的执行顺序、callbacks（`signIn` / `jwt` / `session`）
- 2FA TOTP 的密钥加密存储 + backup codes 的 one-shot 验证
- Active Session = `DeviceSession` 表 + `sid` JWT claim 的双向校验
- WebAuthn / Passkey 的"挑战 → 签名 → 验证公钥"流程（Draft 阶段，先理解理论）
- BoxyHQ Jackson 的 SAML 元数据交换、SP-initiated vs IdP-initiated

**推荐外部资料**

- [Auth.js v5 docs](https://authjs.dev) — 全部章节
- [RFC 0002](../rfcs/0002-security-compliance.md)、[RFC 0004](../rfcs/0004-sso.md)、[RFC 0007](../rfcs/0007-webauthn-passkey.md) — **这三份 RFC 是本周最重要的资料**
- [SimpleWebAuthn 教程](https://simplewebauthn.dev/docs)

**项目内必读代码**

- `src/lib/auth/config.ts` 全文
- `src/lib/auth/session.ts` + `src/lib/auth/2fa-totp.ts`
- `src/app/api/auth/[...nextauth]/route.ts` — 入口
- `src/app/api/auth/sso/start/route.ts` 与 `callback/route.ts` — SSO 握手
- `src/app/[locale]/(auth)/login/2fa/page.tsx` — 2FA 拦截页

**周末自我验证**

- ☐ 解释清楚：用户改密码后，**已经登录的其他设备**怎么被踢下线？答案到不到第二跳？
- ☐ 不查代码画出 SSO 登录的完整时序图（浏览器 / SP / IdP / DB）
- ☐ 在 dev 环境自己跑一遍：注册 → 验证邮箱 → 启用 2FA → 退出 → 用 backup code 登录

---

## Week 5 · 业务横切：Region · Billing · Jobs · i18n

**目标**：能在多区域语境下添加新功能，不踩"国内国外不一致"的坑。

**知识点**

- Multi-region share-nothing 的真正含义（[RFC 0005](../rfcs/0005-data-residency.md) §5、§6）
- Provider Pattern：`BillingProvider` / `StorageProvider` / `EmailProvider` 接口的 stripe / alipay / wechat 多实现
- 中国大陆支付的"服务端推回调"模式与海外的"前端跳转"模式差异
- 本地化的三个层级：URL 前缀 / 服务端翻译 / 客户端翻译；邮件里怎么传 locale
- 后台任务的幂等性、退避策略、cron tick 的去重机制

**推荐外部资料**

- [RFC 0005](../rfcs/0005-data-residency.md)、[RFC 0006](../rfcs/0006-cn-region-deployment.md)、[RFC 0008](../rfcs/0008-background-jobs.md) — 必读
- 文章：Stripe 官方的 "Designing Idempotent APIs"
- next-intl 文档的 "Routing" 与 "Server Components" 章节

**项目内必读代码**

- `src/lib/region.ts` 全文 + `src/lib/region/providers.ts`
- `src/services/billing/provider/types.ts` + 三个实现（`stripe.ts` / `alipay.ts` / `wechat.ts`）
- `src/app/api/stripe/webhook/route.ts` 与 `src/app/api/billing/alipay/notify/route.ts` 对比读
- `src/services/jobs/` 全部（这是本项目最自豪的一块自研——读懂受益终生）
- `src/i18n/` + `messages/` 一份语言包

**周末自我验证**

- ☐ 假设要新增"巴西区"，画出落地清单（schema、env、provider、部署、合规）
- ☐ 解释清楚：为什么 Stripe webhook 一定要校验签名，但首屏渲染不需要？
- ☐ 自己写一个新 background job（比如"每天清理过期 invite token"），用现有抽象接进 cron

---

## Week 6 · 独立交付一个 feature + 性能与质量

**目标**：从 RFC 草稿到 PR 合并，端到端跑一次。

**知识点**

- 写 RFC 的最小模板（见 [rfcs/README.md](../rfcs/README.md)）
- Bundle 分析：`next build` 的输出怎么读、什么时候应该 dynamic import
- React Server Component 的 streaming 行为对 LCP / TTFB 的影响
- 安全加固：rate limit、CSRF、SQL injection（Prisma 自带防御）、XSS（React 自带防御 + dangerouslySetInnerHTML 黑名单）
- Sentry 错误分组、`addBreadcrumb` 的使用时机
- Playwright 的 fixture 复用与 storageState 提速

**推荐外部资料**

- 文章：[Next.js Performance Best Practices](https://nextjs.org/docs/app/building-your-application/optimizing) 全节
- [OWASP Top 10 (2021)](https://owasp.org/Top10/) — 至少看 A01 / A02 / A03 / A07
- [Sentry · Performance Monitoring for Next.js](https://docs.sentry.io/platforms/javascript/guides/nextjs/)

**项目内必读代码**

- `src/lib/rate-limit.ts` 全文
- `src/services/audit.ts` — 审计日志的写入抽象
- `next.config.mjs` — 看自定义的 image / headers / experimental flag
- `sentry.*.config.ts` 三件套

**毕业作业（择一）**

- ☐ **小型**：给 dashboard 加一个"近 30 天活跃设备图表"——server component 读数据 + recharts 渲染 + 加个单测
- ☐ **中型**：实现一个"邀请链接过期自动清理"job，含 RFC（即使是 mini RFC）+ 实现 + 测试
- ☐ **大型**：补一个尚未实现的合规功能（比如"账户删除前最后一次邮件提醒"），走完 RFC → PR-1...PR-N 流程

---

## 通用学习方法建议

1. **资料按"必读 / 推荐 / 闲时"分级**，不要一次想读完所有。
2. **每读一段官方文档之后立即看项目里的对应代码**——脱离上下文的概念学习会快速遗忘。
3. **遇到不理解的地方先记下来，48 小时后再回看**。很多概念第一次看不懂是正常的，过几天写过几行代码就豁然开朗。
4. **不要害怕看 RFC**——它们篇幅长是因为信息密度高。本项目大半的"为什么这样设计"都在 RFC 里。
5. **每周末写 200 字"本周学到了什么"**给自己看，比盲跑节奏有效。
6. **找一个 mentor 每周 30 分钟 pair**——本路线设计成自学，但有人对答案永远更快。

---

## 参考的官方与社区资料合集（一处入口）

| 主题              | 资料                                       |
| ----------------- | ------------------------------------------ |
| React             | https://react.dev                          |
| Next.js           | https://nextjs.org/docs                    |
| Prisma            | https://www.prisma.io/docs                 |
| Auth.js           | https://authjs.dev                         |
| next-intl         | https://next-intl-docs.vercel.app          |
| TypeScript        | https://www.totaltypescript.com            |
| Zod               | https://zod.dev                            |
| Vitest            | https://vitest.dev                         |
| Playwright        | https://playwright.dev                     |
| Tailwind          | https://tailwindcss.com/docs               |
| shadcn/ui         | https://ui.shadcn.com                      |
| Stripe            | https://stripe.com/docs                    |
| 阿里云 OSS        | https://help.aliyun.com/product/31815.html |
| 阿里云 DirectMail | https://help.aliyun.com/product/29412.html |
| OWASP             | https://owasp.org/Top10/                   |
