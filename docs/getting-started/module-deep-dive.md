# 各模块深挖 · 设计权衡与边界情况

> 与速通手册和学习路线的关系：
>
> - **vue-to-nextjs.md** — 1 ~ 2 周速通对照，"它对应 Vue/Midway 的什么"
> - **learning-path.md** — 4 ~ 6 周体系化学习路线，"按周怎么学"
> - **本文档** — 资深工程师向，"为什么这样设计、不那样设计；什么情况会崩；将来怎么演进"
>
> 本文不重复前两份文档讲过的内容，重点是 **trade-off** 与 **failure mode**。RFC 是这些权衡的原始记录，本文是面向工程实践的整理摘要——遇到争议时**以 RFC 为准**。

每个模块按相同结构组织：① 问题定义 ② 设计选项 ③ 选定方案 ④ 核心抽象 ⑤ 已知陷阱 ⑥ 演进方向。

---

## 1 · Region（多区域 share-nothing）

> 一切其他模块的"地基"。先理解它，其他设计才讲得通。

### 1.1 问题定义

- 海外用户与国内用户**不能共用**数据库（PIPL / 网络安全法）
- 欧盟用户**未来**可能要求 EU 驻留（GDPR + Schrems II）
- 但代码必须**单仓库**——三个 fork 维护成本爆炸

### 1.2 设计选项

| 方案                                                  | 代价                                 |
| ----------------------------------------------------- | ------------------------------------ |
| 同一 DB，按租户行级分区，应用层读写时带 region 过滤   | **不合规**：物理上数据仍在同一台机器 |
| 同一代码库，按 region 分库分表（multi-tenant in DB）  | 跨境网络延迟 + 监管不允许            |
| **share-nothing：每 region 一套独立栈，编译时不区分** | 部署复杂度上升，但合规 + 代码统一    |

选定 share-nothing。RFC 0005 §6 详述。

### 1.3 核心抽象

- `KITORA_REGION` 是**进程生命期常量**，启动时校验、运行时只读
- `currentRegion()`（`src/lib/region.ts`）是**唯一入口**——禁止 `process.env.KITORA_REGION` 直读
- 每张租户表带 `region` 列：**不参与查询逻辑**，只为审计 / 迁移 / 取证用
- Provider 工厂（`src/lib/region/providers.ts`）按 region 选择 Stripe / Alipay / S3 / OSS / Resend / DirectMail

### 1.4 已知陷阱

- **不要写 `if (region === 'CN')`**——一旦出现这种 if，等价于在业务层泄漏 region 知识，maintain 成本指数级。永远走 provider 工厂。
- 测试里要 mock region：用 `vi.mock('@/lib/region', () => ({ currentRegion: () => 'CN' }))`，不要改 `process.env`。
- 跨区域**只走 HTTP**：GLOBAL 给 CN 推 webhook 用 RFC 0003 那一套。**不要**任何"读对方 DB"的奢望。
- 旧的 `REGION=cn` 还在弃用窗口（v0.6 + v0.7 兼容，v0.8 移除）——添加新 env 的时候不要重蹈覆辙，命名一次定型。

### 1.5 演进方向

- EU 区从"占位符"激活时，主要工作是采购 EU 端点（Stripe EU、S3 eu-west-1）+ 部署独立栈。代码改动很少。
- 未来若新增区域（比如 `JP` / `BR`），照同一套模板克隆即可——这是 share-nothing 的最大红利。

---

## 2 · 鉴权（Auth.js v5）

### 2.1 问题定义

- 邮箱密码 + 第三方 OAuth + WebAuthn + 2FA + SSO 同时支持
- 账户安全事件（改密 / 设备登出 / 删除）必须**全设备生效**
- 既要"7 天免登"的体验，又要"立即踢人"的安全

### 2.2 设计选项：JWT vs DB Session

|          | JWT                | DB Session     |
| -------- | ------------------ | -------------- |
| 性能     | 无 DB 调用，快     | 每请求查表     |
| 即时撤销 | 不可能（直到过期） | 简单（删 row） |
| 跨域共享 | 容易               | 复杂           |

选 JWT，但用 **`User.sessionVersion`** 字段做"逻辑撤销"——每次签 JWT 时把当前 version 写进 claim，jwt callback 比对，不匹配就强制重新登录。改密 / 删账户 / 用户主动"在所有设备登出" → bump 这个数。

副作用：**jwt callback 需要查 DB**——但只在校验时查一次，比每请求查 session 表轻。

### 2.3 核心抽象

- `auth()`（`src/lib/auth/session.ts`）— 所有页面 / Action 拿当前用户的**唯一入口**
- `signIn` callback — 决定能否登录（拒绝未验证邮箱、拒绝 2FA 未通过等）
- `jwt` callback — 把额外字段（`sessionVersion`、`sid`、`twoFactorVerified`）塞进 token
- `session` callback — 把 token 字段透出到客户端可见的 session
- TOTP 密钥**永不明文落库**：用 `2fa-crypto.ts` 的 AES-GCM 加密，密钥来源是 `AUTH_SECRET`
- Backup codes 是**一次性**的：bcrypt 哈希存储，使用后立即标记 used

### 2.4 已知陷阱

- **永远不要在 client component 里读 `useSession`**——本项目走 server-first，session 通过 props 从 layout 透传到子组件。`useSession` 只在极少数交互场景用。
- 改 jwt callback 后**所有用户 JWT 立刻无效**（结构变化）——上线前广播，准备好"被迫重新登录"的客服话术。
- 2FA 拦截：登录成功后**进入 `/login/2fa`**，state 通过短期 cookie 传递（`two-factor-state.ts`）。**不要**用 query string，会被 referer 泄漏。
- WebAuthn 的 RP ID 跟域名绑定——multi-region 自然 share-nothing（kitora.io 的 passkey 用不到 kitora.cn）。这是 RFC 0007 的天然好处。

### 2.5 演进方向

- Passkey 落地（RFC 0007 Draft）：作为 2FA 因子和密码快捷登录两条路并行
- "可信设备"概念：30 天内同设备免 2FA，已经在 `DeviceSession` 里有钩子，待产品确认 UI

---

## 3 · SSO + SCIM

### 3.1 问题定义

B2B 客户的 IT 部门会要求：

- 员工**不在 Kitora 注册**——从他们的 IdP（Okta / Azure AD）单点登录
- 员工入职 / 离职**自动同步**——不要让 IT 手动 invite

第一条是 SSO（SAML/OIDC），第二条是 SCIM v2。

### 3.2 设计选项

| 方案                                                                  | 代价                                                  |
| --------------------------------------------------------------------- | ----------------------------------------------------- |
| 自己实现 SAML                                                         | SAML 协议复杂、签名/加密/重放各种坑、社区轮子已经成熟 |
| 用 [`@boxyhq/saml-jackson`](https://boxyhq.com/docs/jackson/overview) | 轻依赖、SAML + OIDC 一套 API、有 multitenancy 内置    |
| 用 WorkOS / Stytch 这类 SaaS                                          | 第三方依赖 + 额外费用 + 跨境合规复杂                  |

选 BoxyHQ Jackson——既不自造，又不被 SaaS 锁住。

### 3.3 核心抽象

- `/api/auth/sso/start` — 开始握手，参数是 `tenant`（org slug）+ `product`（固定 `kitora`）
- `/api/auth/sso/callback` — IdP 回调落点，把 IdP 的 user → 本地 `User` 做 link 或 auto-provision
- SCIM v2 `/api/scim/v2/Users`、`/Groups` —— 严格按 [RFC 7643](https://datatracker.ietf.org/doc/html/rfc7643) 实现 schema
- SCIM 鉴权**独立于 NextAuth**：用 Bearer token（每个 org 单独签发），见 `src/lib/api-auth.ts`

### 3.4 已知陷阱

- SCIM 的 `PATCH` 是 [RFC 6902](https://datatracker.ietf.org/doc/html/rfc6902) JSON Patch，**不是** Merge Patch。Okta/Azure 都按这个标准发请求，自己实现时不要省略 path 解析。
- 大多数 IdP 不发 `delete` 而发 `PATCH active=false`——所以本地"删除用户"流程要兼容 active 标志。
- SAML 断言里的 `NameID` 格式有多种（emailAddress / persistent / transient）——不要假设是 email，一定要看 IdP 配置。
- SSO 用户**默认豁免 2FA**（IdP 已经做了）——但 Org 可以强制开启 2FA，这种情况下 SSO 用户也要走 TOTP。RFC 0004 §1。

### 3.5 演进方向

- SCIM 的 `Bulk` endpoint 暂未实现——IdP 大批量同步时还会逐条来，规模大了再补。
- SSO 元数据自动 fetch（IdP 暴露 metadata URL）目前是手动配置——未来可以加定时刷新。

---

## 4 · 数据层（Prisma + Postgres）

### 4.1 问题定义

- 类型安全（与 TS 联动）
- 迁移可审计（不能"线上手改了一下"）
- 与 RDBMS 关系建模能力对齐（不像 NoSQL 那样关系扁平化）

### 4.2 设计选项

| 方案       | 代价                                                                 |
| ---------- | -------------------------------------------------------------------- |
| TypeORM    | 装饰器风格、运行时反射、与 React Server Component 配合微妙、生态分散 |
| Drizzle    | SQL-first、轻量、生态较新                                            |
| **Prisma** | schema-first、类型生成强、迁移工具成熟、Edge runtime 受限            |

选 Prisma。Edge 限制对我们影响很小（Edge 上跑的中间件不查 DB）。

### 4.3 核心抽象

- `prisma/schema.prisma` 是**单一事实源**——任何字段变化都走 `pnpm db:migrate`
- `src/lib/db.ts` 暴露的 `prisma` 是 **`globalThis` 单例**，避免 dev HMR 连接泄漏
- 软删 / 审计字段全局约定：`createdAt` / `updatedAt` 必有，`deletedAt` 按需
- 跨表关系一律用 Prisma 的 `relation`，**不要自己 JOIN SQL**

### 4.4 已知陷阱

- Prisma 在传错类型时**直接抛错**——所以 zod 校验放在 prisma 调用之前，把校验失败和 DB 失败分开。
- 大批量插入用 `createMany` + `skipDuplicates`，逐条 `create` 性能差几个数量级。
- `findUnique` 找不到返回 `null`，但**用 `where` 中的 `unique` 字段必须值齐全**（Prisma 会拒绝部分键的 unique 查询）。
- Connection pool：本地 dev 没问题，但部署到 serverless 时一定要走 PgBouncer / Neon Pooler，否则连接爆炸。
- 多表事务用 `prisma.$transaction([...])`（顺序原子），跨多个独立操作用 `prisma.$transaction(async tx => { ... })`（互斥锁）。

### 4.5 演进方向

- Read replica 路由：Prisma 5.x 已有 `$replica()`，未来读多写少的场景可以接
- Soft delete 全局化：目前手工字段，未来可以用 Prisma extension 统一拦截

---

## 5 · 国际化（next-intl）

### 5.1 问题定义

- URL 必须带 locale 前缀（SEO + 分享链接确定语种）
- 服务端渲染、客户端组件、邮件模板**三处都要能拿翻译**
- 翻译资源给非工程师维护
- ICP 备案信息**只在 CN region** 显示

### 5.2 设计选项

| 方案          | 代价                                                        |
| ------------- | ----------------------------------------------------------- |
| react-intl    | 老牌、API 啰嗦、SSR 配置麻烦                                |
| react-i18next | 客户端为主、SSR 需要额外胶水                                |
| **next-intl** | 专为 Next.js App Router 设计、Server / Client 双侧 API 一致 |

### 5.3 核心抽象

- `src/i18n/routing.ts` — 声明 locales 列表 + 默认 locale
- `src/i18n/request.ts` — server-side hook，从请求中提取 locale
- `messages/<locale>/<namespace>.json` — 资源按 namespace 拆分（不要一个大 JSON）
- Server Component 用 `getTranslations(namespace)`；Client Component 用 `useTranslations(namespace)`
- 邮件里**显式传 `locale`**——`getTranslations({ locale, namespace })`，不依赖请求 scope

### 5.4 已知陷阱

- **不要**在 server action 里假设有 locale scope——server action 不在请求 render 树里，必须显式从参数读 locale 或从 user 表读 `locale` 字段。
- 翻译里带变量用 `{name}` 占位，**不要**字符串拼接——会破坏复数 / 性别变体。
- 复数用 [ICU MessageFormat](https://formatjs.io/docs/core-concepts/icu-syntax/)：`{count, plural, =0 {none} one {# item} other {# items}}`。
- 新加 locale 一定要加完所有 namespace 的 JSON 文件，否则 fallback 到默认语言（用户看到中英混合）。

### 5.5 演进方向

- 翻译资源接 Lokalise / Crowdin，给非工程师 web UI 改翻译
- AI 辅助翻译第一稿（Claude / DeepL），人审一遍

---

## 6 · 计费（Multi-Provider Billing）

### 6.1 问题定义

- 海外 Stripe；国内支付宝 + 微信支付
- 国内 SaaS 月度订阅模式不普遍——需要兼容"按次充值"和"订阅"
- 退款 / 升降级 / Webhook 的**幂等**

### 6.2 设计选项

| 方案                                          | 代价                                       |
| --------------------------------------------- | ------------------------------------------ |
| 业务代码里 `if (region === 'CN')`             | 散落在所有计费相关文件，重构噩梦           |
| **抽 `BillingProvider` 接口，按 region 工厂** | 每个 provider 写两次实现，但调用点完全统一 |

### 6.3 核心抽象

```typescript
// src/services/billing/provider/types.ts
interface BillingProvider {
  createCheckout(opts): Promise<CheckoutSession>;
  createPortal(opts): Promise<PortalSession>;
  handleWebhook(req): Promise<WebhookResult>;
  // ...
}
```

`stripe.ts` / `alipay.ts` / `wechat.ts` 各自实现。`getBillingProvider()` 按 region 选。**业务代码永远调接口**。

### 6.4 已知陷阱

- **Stripe webhook 必须验签**——`Stripe-Signature` header 比对，否则任何人能伪造订阅生效。
- **支付宝/微信回调是服务器推**（异步通知）——`/api/billing/alipay/notify` 必须公网可达 + 返回 `success` 字符串而不是 200 status。微信类似但格式不同。
- **Webhook 必须幂等**：所有 event 写 `BillingEvent` 表去重，重复 event id 直接返回 ack。
- 升降级中段：用户 4-19 号升级，按比例计费——Stripe 自动处理，但支付宝没有这个原生概念，需要业务层自算。
- 中国合规：发票（增值税）必须接进开票系统（金税盘 / 电子发票服务商），目前是占位实现。

### 6.5 演进方向

- 接更多支付方式（Apple Pay / Google Pay 通过 Stripe / Paddle 兜底海外退税合规）
- "用量计费"（按 API 调用数）的抽象——目前订阅是单一形态

---

## 7 · 后台任务（Postgres Queue）

### 7.1 问题定义

- 发邮件、生成数据导出、清理过期 token、webhook 重试
- 不能让用户的请求等这些操作

### 7.2 设计选项

| 方案                             | 代价                                       |
| -------------------------------- | ------------------------------------------ |
| BullMQ + Redis                   | 多一个常驻 Worker 进程、Redis 作为持久化层 |
| Inngest / Trigger.dev            | 第三方依赖、跨境合规复杂、CN 区不可用      |
| Vercel Queue / Cloud Tasks       | 平台锁定、自建 K8s 用不上                  |
| **Postgres 表 + 外部 cron tick** | 简单、不增加依赖、横向能力够用             |

选 Postgres 队列。RFC 0008 详述。规模超过单租户 1k 任务/小时时再考虑迁移。

### 7.3 核心抽象

- `define.ts` — 注册 handler：`defineJob('send-email', handler)`
- `enqueue.ts` — 入队：写一行 `Job` 表
- `runner.ts` — 出队：`SELECT ... FOR UPDATE SKIP LOCKED` 防并发抢同一行
- `runtime.ts` 配套的 `/api/jobs/tick` 是 **cron 入口**——每分钟拉一批 due job 跑
- `retry.ts` — 指数退避：`min(2^attempt, max) * jitter`
- `observability.ts` — 每次执行写日志 + 失败上报 Sentry

### 7.4 已知陷阱

- **handler 必须幂等**：cron 多实例 + 重试可能让同一 job 跑两次。
- 长时任务（超过 5 分钟）要拆——Vercel function timeout、阿里云函数计算 timeout 都有限制。
- `SKIP LOCKED` 是 Postgres 9.5+ 特性，迁移到其他 DB 要改实现。
- cron tick 本身不要超过 1 分钟——否则两个 tick 重叠，去重靠 row lock 但浪费 quota。

### 7.5 演进方向

- 优先级队列（high / normal / low）目前是 hint，没真正调度生效
- 死信队列（DLQ）：超过 N 次失败的 job 进 DLQ 通知运维而非静默
- 规模大了切 BullMQ 或 Inngest——抽象层留好了，迁移成本可控

---

## 8 · 邮件（React Email + 多 Provider）

### 8.1 问题定义

- 模板可视化好维护
- 海外 Resend，国内阿里云 DirectMail（境内 SMTP 走 Resend 容易被退信）
- 模板 i18n

### 8.2 核心抽象

- `src/emails/*.tsx` — react-email 组件，本质是 React 组件，运行时编译 HTML
- `src/lib/email/index.ts` — 发送层抽象，根据 region 选 provider
- 调用点**永远** `await sendEmail(...)`，**禁止**直接 `import { Resend }`

### 8.3 已知陷阱

- DirectMail 的发件域名要**在阿里云控制台预先配置**并通过 SPF / DKIM / DMARC 校验，否则被退。
- React Email 编译时如果用了 `useState`（不该用，但容易写错），SSR 会报错——邮件模板里**只能用 props**，禁止任何 hook。
- 不同邮件客户端（Outlook 老版本、Gmail、Apple Mail）渲染差异大——CSS 限制只能用 inline style + table 布局，react-email 的官方组件已经处理好。
- 测试发送一定走 sandbox / dry-run 模式（`EMAIL_FROM=onboarding@example.com` 或显式 dryRun flag）。

### 8.4 演进方向

- 用户偏好：每种邮件单独允许"取消订阅"（GDPR 要求）
- A/B 测试模板（Resend / DirectMail 都不原生支持，要自己埋点）

---

## 9 · 对象存储（Storage Provider）

### 9.1 问题定义

- 用户头像、数据导出 zip、附件
- 海外 S3 / R2，国内阿里云 OSS
- 大文件**不要**经过 Web 服务器中转——直接前端 → 对象存储

### 9.2 核心抽象

- `src/lib/storage/types.ts` — 接口（`putPresigned` / `getPresigned` / `delete`）
- 三个实现：S3、R2、OSS
- 业务代码调 `getStorage()` 拿 provider

### 9.3 已知陷阱

- 预签名 URL 一定要带过期时间（10 分钟够用），不要签发长效 URL。
- OSS 的 bucket 默认私有，每次 `OSS putBucketCORS` 配置好上传 origin，否则 preflight 失败。
- 数据导出文件**不要永久存**——RFC 0002 §10 规定 7 天后自动删除（job 跑）。
- 前端上传时**校验文件类型 + 大小**，但**绝不依赖前端**——server-side 也要校验，防绕过。

---

## 10 · 速率限制（Upstash Redis）

### 10.1 问题定义

- 登录、忘记密码、注册等敏感 endpoint 必须节流，防爆破
- 不想自己跑 Redis（运维负担）

### 10.2 核心抽象

- `@upstash/ratelimit` 的 sliding window
- key 模式：`<endpoint>:<userId|ip>`
- 没配 Upstash 凭证时**降级 no-op**（dev 无痛）

### 10.3 已知陷阱

- key 一定要带 endpoint 前缀，否则不同 endpoint 互相污染配额。
- IP 在 Vercel 后面要看 `x-forwarded-for`（取最右一段是正确的，最左可能被伪造）。
- 跨 region 不共享 Redis——CN 栈接阿里云 Redis，GLOBAL 接 Upstash。这是 share-nothing 的体现。
- "全局限流"（不分用户的总 QPS 阈值）目前没做——单租户 SaaS 暂时不需要。

---

## 11 · 可观测（Logger + Sentry + Analytics）

### 11.1 核心抽象

- **日志**：`pino`，结构化 JSON。**禁止 `console.log`**，包括 dev 环境。
- **错误监控**：`@sentry/nextjs` 已经在 `sentry.*.config.ts` 配好。Server Action / Route Handler 的异常自动上报。
- **前端打点**：`src/lib/analytics.ts` 是抽象层，本地 noop，生产可接 PostHog / Plausible。

### 11.2 已知陷阱

- **不要把敏感信息进日志**：密码 / token / 完整邮件 body / PII。pino 的 `redact` 配置好黑名单。
- Sentry 的 `beforeSend` 也要 redact 一遍——server action 的 error payload 默认不带敏感数据，但不能假设。
- 日志量在生产可能爆炸——在 hot path 用 `logger.debug` 而不是 `info`，按级别裁剪。

---

## 12 · API 契约（OpenAPI + Webhooks）

### 12.1 问题定义

- 对外的 `/api/v1/*` 必须有契约——给客户写 SDK、给 Scalar 渲染交互文档
- Webhook 必须自描述（type 字段稳定、payload 字段语义稳定）

### 12.2 核心抽象

- `openapi/v1.yaml` 是**手写的**单一事实源（不自动从代码生成——保证文档表述比代码精确）
- `scripts/check-openapi-coverage.ts` 在 CI 检查"实现的 endpoint 是否都在 spec 里"
- `/api/openapi/v1.yaml` 是 raw spec 出口，`/<locale>/docs/api` 用 Scalar 渲染
- Webhook signature: HMAC-SHA256(secret, body)，header 带 `X-Kitora-Signature` + `X-Kitora-Timestamp`，5 分钟 skew 内有效（防重放）

### 12.3 已知陷阱

- 加 `/api/v1/*` 必须**同步**改 `openapi/v1.yaml`，否则 CI 红
- Webhook payload 一旦发布字段**只增不删不改语义**——客户依赖你的 schema
- Webhook 重试：HTTP 4xx 不重试（客户端错误，重试白费），5xx 和超时按指数退避重试至多 N 次
- 客户验签是**他的责任**——你只能给清晰的 sample code，不能强制

---

## 13 · 模块间的耦合关系（不能切的依赖）

模块设计成"可单独学习"，但生产环境跑起来它们互相咬合。下图列出强耦合点：

```
                          ┌─────────────┐
                          │   Region    │  ← 所有模块都读 currentRegion()
                          └──────┬──────┘
                                 │ chooses
        ┌─────────┬──────────────┼──────────────┬─────────┐
        ▼         ▼              ▼              ▼         ▼
   Billing    Storage         Email         RateLimit   Logger
   provider   provider       provider       (Redis URL) (Sentry DSN)

   Auth ─── reads ─── User table ─── lives in ─── Prisma ─── (Region 决定 DB)
    │
    ├─ rate-limit on /api/auth/* (防爆破)
    ├─ audit logs (审计)
    └─ session events (Active Sessions)

   Jobs ─── enqueue / run ─── Email (sendEmail)
                            ── Webhook (出站投递)
                            ── DataExport (生成 zip → Storage)

   Webhook ─── 出站签名用 ─── HMAC secret per Org ─── stored in Org table
              重试退避用 ─── Jobs runtime
```

**接 issue 时的检查清单**：

- 改 Auth 配置 → 想想会不会 invalidate 所有现存 JWT
- 改 Region 默认值 → **永远不改**，只能加新值
- 改 BillingProvider 接口 → 三个实现全要同步改
- 改 Job handler 签名 → 想想正在队列里的旧消息怎么兼容
- 改 Webhook payload → 客户已经依赖，加字段不改字段
- 改 Prisma schema → 一定走 migration，不要 `db push` 上生产

---

## 14 · 复盘建议

每读完一个模块，问自己以下三个问题：

1. **业务问题驱动**：如果团队明天宣布"放弃中国区"，这个模块需要改什么？反过来，"放弃海外区"呢？答案的差异告诉你模块对 region 的耦合强度。
2. **替换成本**：如果要把 Prisma 换成 Drizzle、Stripe 换成 Paddle、Resend 换成 SendGrid，工作量是多少天？答案告诉你抽象层是否真的有用。
3. **失败模式**：这个模块**会以什么方式坏**？数据不一致？性能崩溃？合规违规？答案告诉你监控和告警该埋在哪里。

资深工程师与初级工程师的差距，就在这三个问题的回答精度上。本文档帮你把"标准答案"列出来——但你要自己**反刍**，才能内化成下意识的判断力。
