# Changelog

本文档遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。每个 minor 版本对应一个 RFC 的落地，详细背景见 `docs/rfcs/`。

## [0.9.0] — 2026-04-27

### 主题

**RFC 0008 — 通用 Background Jobs 抽象**：把分散自写的 webhook / export / deletion 三套 sweep tick 收归到统一的 `BackgroundJob` 表 + `defineJob` / `defineSchedule` / `enqueueJob` 三件套，落地 PostgreSQL `FOR UPDATE SKIP LOCKED` 抢锁的多 worker 安全 claim 算法、5 阶 / 8 阶 / fixed / custom 四档重试策略、DEAD_LETTER + admin 手动 retry / cancel 闭环、Sentry transaction + RFC 0006 metrics 双轨可观测性。三个旧 cron 脚本退化为 thin shim，外部 cron 配置可平滑迁移到新的 `pnpm tsx scripts/run-jobs.ts` CLI 单一入口或 Vercel `/api/jobs/tick` 路由。

### Added

- **PR-1 schema + 核心 lib + 单元测试**
  - Migration `20260601200000_add_background_job/`：纯加 `BackgroundJob` 表（11 列 + `BackgroundJobStatus` 6 状态 enum）+ 4 个索引：`(type, runId)` unique（幂等键）/ `(status, queue, priority, nextAttemptAt)` claim 热路径（与 worker `WHERE` + `ORDER BY` 完全对齐，索引驱动 sort）/ `(deleteAt)` prune 单列范围 / `(type, status)` admin filter。
  - `src/lib/jobs/registry.ts` —— `globalThis[Symbol.for('kitora.jobs.registry.v1')]` singleton（HMR / vitest forks / tsx 多次 import 同进程都安全），`registerJob<TPayload, TResult>(def)` + `getJob(type)` + `listJobTypes()` + Schedule 同款。
  - `src/lib/jobs/retry.ts` —— `nextRetryDelayMs(attempt, maxAttempts, strategy)` 三策略：`exponential`（webhook 同款 `[0, 30s, 2m, 10m, 1h, 6h, 12h, 24h]`）/ `fixed`（60s）/ `{ strategy: 'custom', delays: [...] }`。
  - `src/lib/jobs/define.ts` —— `defineJob(opts)` / `defineSchedule(opts)` 包装注册，defaults：maxAttempts=5、retentionDays=7、retry='exponential'、queue='default'、timeoutMs=8000（< Vercel Hobby 10s 安全档）。
  - `src/lib/jobs/enqueue.ts` —— `enqueueJob(type, payload, opts?)` 通用入口（v1 通用签名 + zod runtime 校验 + 64KB 字节数 check）+ `cancelJob(id)` 仅翻 PENDING；P2002 swallow 让相同 `(type, runId)` 重复 enqueue 走 `{ deduplicated: true }` 复用既存行。
  - `src/lib/jobs/runner.ts` —— `runWorkerTick(workerId, opts)` 三阶段（recover stuck → 循环 claim batch + run → 5s 尾保护），claim 用 `prisma.$queryRaw` 跑 `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`、claim 时 `attempt = attempt + 1` 同步 bump 让 retry 决策一致；run 用 `Promise.race(handler, setTimeout)` 控制 def.timeoutMs；4 outcome：succeeded / retry / dead-letter / unknown-type。
  - `src/lib/jobs/observability.ts` —— `JobMetricsHook` 接口（onSuccess / onFailure / onDeadLetter / onTickComplete）+ `setMetricsHook` 注入 + `withJobTransaction` v1 占位（PR-4 替换为真实 Sentry）。
  - 5 个 vitest 单测共 562 行覆盖：retry 三策略 8 阶 / fixed / custom / 越界、registry 注册 + 重复抛错 + reset、define defaults 注入、observability metrics noop / 注入 / withJobTransaction 透传、enqueue mock prisma 覆盖 unknown / payload 校验失败 / 64KB / 成功 / P2002 swallow / cancel。
  - `package.json` 加 `vitest@^2.1.8` devDep + `test:unit` / `test:unit:watch` 两个 npm script + `vitest.config.ts`（node env、`@/*` alias 对齐 tsconfig、forks pool 隔离 module-level singleton）。
- **PR-2 defineSchedule + 单一 CLI + 三脚本迁移**
  - `src/lib/jobs/cron.ts` —— minimal cron matcher 169 行无外部 dep，支持 `*` / `N` / `N-M` / `*\/N` / `N-M/K` / `A,B,C` 6 种语法，UTC 时区，标准 Vixie cron dom/dow OR 合；`parseCronExpression` 错误抛错让 `defineSchedule` 在启动时立刻冒错。
  - `src/lib/jobs/schedules.ts` —— `fireSchedules(now?)` 投影主入口：遍历 ScheduleRegistry → matchesCron → `enqueueJob(jobType, payload, { runId: 'schedule:<name>:<unixMinute>' })`，runId 后缀加 `(type, runId)` unique 索引让同分钟重复触发自然走 P2002 swallow；某 schedule 抛错不阻塞其它（logger.error 后继续）。
  - `src/lib/jobs/jobs/{webhook-tick,export-tick,deletion-tick}.ts` —— 三个 thin wrapper job，`maxAttempts: 1`（sweep 失败下一分钟自然再来）、`retry: 'fixed'`、`retentionDays: 1`，run handler 仅调既有 `runWebhookCronTick` / `runExportJobsTick` / `runDeletionCronTick` 不重写既有逻辑（RFC §2「借坡下驴」）。
  - `src/lib/jobs/bootstrap.ts` import barrel + `scripts/run-jobs.ts` 57 行 CLI 单一入口（`import '@/lib/jobs/bootstrap'` → `fireSchedules` → `runWorkerTick`）。
  - `refactor` 把 `scripts/run-export-jobs.ts` / `run-deletion-cron.ts` 主体逻辑分别抽到 `src/lib/data-export/cron.ts`（`runExportJobsTick()`）与 `src/lib/account/deletion-cron.ts`（`runDeletionCronTick()`），旧脚本退化为 thin shim（与既有 `run-webhook-cron.ts` 同结构 27 行）。
  - `src/lib/jobs/{cron,schedules}.test.ts` 单测覆盖 cron 各模式 + 边界 + matchesCron 4 种生产 cron + dom/dow OR 合 + fireSchedules mock enqueue 的转调形状。
- **PR-3 首批新 jobs**
  - `src/lib/audit.ts` `AUDIT_ACTIONS` 加 `job.cancelled` / `job.retried` —— runner 自身**不**为 DEAD_LETTER 写 audit（避免噪音，由 metrics + Sentry 已覆盖），仅 admin `/admin/jobs` UI 上手动 cancel / retry 一行 DLQ 时写 audit（PR-4 接入）。
  - `src/lib/jobs/jobs/token-cleanup.ts` —— cron `0 * * * *` 每小时，`Promise.all` 并发清三表：PasswordResetToken / EmailVerificationToken（`consumedAt 非空 OR expires < now()-7d`）+ Invitation（`accepted/revoked OR expiresAt < now()-30d`）；保留 7d / 30d 宽限给 forensic 追查。
  - `src/lib/jobs/jobs/job-prune.ts` —— cron `0 4 * * *` 每天 UTC 04:00（错峰 deletion `0 3 * * *`）；defensive `status in 4 终态 AND deleteAt < now() AND deleteAt IS NOT NULL` filter。
  - `src/lib/jobs/jobs/email-send.ts` —— `email.send` job 用 zod `discriminatedUnion('template')` 覆盖 `password-reset` / `org-invitation` / `data-export-ready` 三模板；`maxAttempts: 5` + `retry: 'exponential'` 5 阶（attempt 1-5 = [立即, 30s, 2m, 10m, 1h]）；`renderTemplate(payload)` switch 必穷尽（`noFallthroughCasesInSwitch` + discriminated union 漏写支强制冒错）。
  - `enqueueEmail(payload, opts?)` typed helper 转调 `enqueueJob('email.send', ...)`，调用方 IDE 自动补全准确 props，发布前类型错误就被抓出来。
  - 三对应 `*.test.ts` 单测覆盖注册参数 + run 行为 + zod 校验各模板 props 形状。
  - `bootstrap.ts` 加 3 行 import 触发副作用注册。
- **PR-4 admin / Sentry / Vercel Cron 路由 / 部署文档**
  - `src/env.ts` 加 `CRON_SECRET: z.string().min(32).optional()`，注释说明生产 `openssl rand -base64 32` 生成、dev 留空 + route 503 短路、CLI 入口不受影响。
  - `src/app/api/jobs/tick/route.ts` —— GET handler，`runtime='nodejs'` + `maxDuration=60`、`Cache-Control: no-store`，503（CRON_SECRET 未配）/ 401（鉴权失败）/ 200 / 500 四档；`import '@/lib/jobs/bootstrap'` 触发注册 → `fireSchedules + runWorkerTick`。
  - `vercel.json` `crons: [{ path: '/api/jobs/tick', schedule: '* * * * *' }]` 1 个 schedule 覆盖整个 jobs infra。
  - `src/app/[locale]/(admin)/admin/jobs/page.tsx` 481 行三 Tab：**overview**（24h `groupBy(type, status)` pivot 表 + 总行数 / DLQ / queueLag 三张 stat card，DLQ > 0 / lag > 120s 自动 warn 着色）、**recent**（最近 100 行明细 + type/status 双轴过滤 + distinct types 动态 chip）、**dlq**（仅 DEAD_LETTER + 行级 retry/cancel 按钮 + 排查告警文案）；`StatusPill` 6 状态色彩映射；lastError 截断 200 字。
  - `src/components/admin/jobs/job-row-actions.tsx` 客户端按钮（`useTransition` + sonner toast + i18n + cancel 走 `confirm()`）。
  - `src/components/admin/admin-nav.tsx` 加 `ListTodo` icon + `/admin/jobs` 入口。
  - `src/lib/admin/actions.ts` 追加 `cancelJobAction({ jobId })` + `retryJobAction({ jobId })` 两个 server actions：`requireAdmin()` 防护 → 限定 status（cancel 接 DEAD_LETTER/PENDING、retry 仅 DEAD_LETTER）→ 写 `recordAudit({ action: 'job.cancelled' / 'job.retried' })` → `revalidatePath('/admin/jobs' + '/admin/audit')`。
  - `src/lib/jobs/observability.ts` Sentry transaction 真实集成：`loadSentry()` lazy loader 缓存 SDK 模块；`Sentry.startSpan({ op: 'job', name: type, attributes: { 'job.id', 'job.attempt' } })` 包每个 job 执行;catch 调 `Sentry.captureException(err, { tags: { jobType }, extra: { jobId, attempt } })`；dynamic import + try/catch fallback 兼容 tsx CLI / vitest 环境（SDK 加载失败走 logger-only 透传）。
  - `messages/{en,zh}.json` 加 `admin.nav.jobs` + 完整 `admin.jobs.*` 段（tabs / overview / status / recent.totalHint with placeholder / dlq / table / actions）。
  - `docs/deploy/{global,cn,eu}.md` 各加 `## Background jobs cron` 部署段：global = Vercel Cron 三步 + Hobby 收紧示例、cn = Aliyun ACK CronJob YAML + concurrencyPolicy=Forbid + UTC 时区换算 BJ 时间提示、eu = 占位引用 global。
- **PR-5 i18n + e2e + 文档收尾**
  - `tests/e2e/jobs.spec.ts` —— 5 case Playwright e2e 走真 PG：SUCCEEDED 路径（result + deleteAt 设置）/ retry 路径（PENDING + nextAttemptAt 推后）/ DEAD_LETTER 路径（attempt >= maxAttempts）/ cancelJob（PENDING → CANCELED + 重复 cancel 已 CANCELED 行返回 false）/ runId 重复 enqueue P2002 swallow 返回同 id；每 test 用 unique `e2e.test-<rand>` jobType 避免 registry 冲突。
  - `docs/rfcs/0008-background-jobs.md` §11 实施完成段回填（PR 文件清单 + 未交付项 + §9 决策回填 + 首日观测指标）。
  - `package.json` 0.8.0 → 0.9.0；本 changelog 段。

### Changed

- `scripts/run-export-jobs.ts` 与 `scripts/run-deletion-cron.ts` 由「内含全部 sweep 逻辑」退化为 thin shim 调 lib 函数（参考既有 `run-webhook-cron.ts` 同结构）；老外部 cron 配置仍可继续跑，但下一个 minor（v0.10）会清理。
- 新建 RFC 0001–0007 时未涉及的 `BackgroundJob` 表是平台级表，不挂 org（RFC §10），region-bound（CN region 单独的 PG 实例有自己的 BackgroundJob 行）。
- 项目首次引入单元测试体系（vitest）。`pnpm test:unit` 跑 `src/**/*.test.ts`，与 `pnpm test:e2e` 的 Playwright 套并存。

### Migration / Operations

- **部署侧需要切换 cron 入口**：从分别配 3 个 `pnpm tsx scripts/run-{webhook-cron,export-jobs,deletion-cron}.ts` 切到单条 `pnpm tsx scripts/run-jobs.ts`（自托管 / Fly Machines / Aliyun ACK CronJob）或开启 Vercel `vercel.json` 的 `/api/jobs/tick` 路由。三个旧脚本作为 thin shim 保留一个 minor，外部 cron 可平滑迁移。
- **生产环境必须配 `CRON_SECRET`**（≥32 字符强随机串，`openssl rand -base64 32` 生成）才能让 Vercel Cron 跑通；env 未配时路由 503 短路（cron 静默 noop，不会跑未鉴权 sweep）。
- Prisma migration `20260601200000_add_background_job/` 是纯加性变更，零停机；回滚 = `DROP TABLE "BackgroundJob"` + `DROP TYPE "BackgroundJobStatus"`（无外键依赖）。
- 旧 webhook / export / deletion 三套领域状态机**保留不动**（RFC §2「借坡下驴」）：`WebhookDelivery` / `DataExportJob` / `User.deletionScheduledAt` 三套退避 / claim / 自禁用全部领域逻辑保持原样，新 BackgroundJob 表只负责调度它们的 sweep tick。
- Cron 表达式时区 = **UTC**（RFC §10）。`'0 3 * * *'` 是 UTC 03:00 = CN 11:00；如 ops 期望北京时间凌晨 3:00 跑 deletion，把 `defineSchedule` cron 改 `'0 19 * * *'`（前一天 UTC 19:00 = 北京 03:00）。

### Notes

- v0.9.0 是 Kitora 模板的第八个 RFC 落地版本。
- `enqueueEmail()` typed helper（PR-3）覆盖 password-reset / org-invitation / data-export-ready 三模板；强一致场景（注册 verify-email、登录提示 2fa-enabled / -disabled、welcome）继续走 `sendEmail()` 同步直发，等不到 30s/2m 退避。
- `/api/jobs/tick` **不**进 `openapi/v1.yaml`（内部端点 + Vercel Cron 专属路径）。
- 单 tick batch 默认 5、单 job timeoutMs 默认 8s、tick 总预算 50s（Vercel Pro 60s function timeout 留 10s 兜底）；Hobby 部署需要在 route 层显式调 `runWorkerTick(workerId, { budgetMs: 8_000, batchSize: 1 })`，已在 `docs/deploy/global.md` 注明。

## [0.8.0] — 2026-04-26

### 主题

**RFC 0007 — WebAuthn / Passkey 双轨**：Passkey 同时作为 2FA 因子（与 TOTP 并列）和密码快捷登录入口（`/login` 上的 Discoverable / usernameless 流），完整落地。整套能力默认关闭，需要把 `WEBAUTHN_RP_ID` + `WEBAUTHN_ORIGIN` 两个 env 同时显式配置才会激活；这是 RFC §6.1 写死的回滚开关。

### Added

- **PR-1 schema + 库依赖 + 核心 lib**
  - Migration `20260601100000_add_webauthn_credential/`：纯加表（`WebAuthnCredential` 表，`credentialId @unique`，`publicKey Bytes`，`counter Int`，`transports String[]`，`deviceType` / `backedUp` / `name` / `lastUsedAt`，FK cascade 到 `User`）+ 加列（`User.webauthnChallenge` / `User.webauthnChallengeAt` 暂存挑战）。
  - `src/lib/webauthn/config.ts` — `getRpId()` / `getRpName()` / `getOrigin()` 按 env 读，env 缺省时从 `NEXT_PUBLIC_APP_URL` 提主机名兜底，便于 dev / e2e。
  - `src/lib/webauthn/challenge.ts` — `mintChallenge` / `consumeChallenge`，5 分钟 TTL，读时校验过期 + 一次性消费。
  - `src/lib/webauthn/verify.ts` — `verifyRegistration` / `verifyAuthentication` 包装 `@simplewebauthn/server` v13.x，异步 lazy import；统一在 `Buffer → Uint8Array` 边界做 `new Uint8Array(buf)` 复制，规避 SDK 类型对 `SharedArrayBuffer` 的歧义。
  - `package.json` 新增 `@simplewebauthn/server@^13.3.0` + `@simplewebauthn/browser@^13.3.0`；`src/env.ts` 新增 `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ORIGIN` 三个 env。
- **PR-2 注册流 + settings 页 + two-factor-state 抽象**
  - `src/app/api/auth/webauthn/register/options/route.ts` — `generateRegistrationOptions`，`userVerification: 'preferred'`，`excludeCredentials` 灌已有 credential 防止重复注册。
  - `src/app/api/auth/webauthn/register/verify/route.ts` — zod 校验、消费 challenge、`verifyRegistration`、单事务 `webAuthnCredential.create` + `recomputeTwoFactorEnabled`、audit `webauthn.credential_added`。
  - `src/app/api/auth/webauthn/credentials/[id]/route.ts` — PATCH 重命名 + DELETE（同事务内 recompute `twoFactorEnabled`，gate 在 `userId == requireUser().id`）。
  - `src/app/[locale]/(dashboard)/settings/security/passkeys/page.tsx` — RSC 列表页，`orderBy: [{ lastUsedAt: { sort: desc, nulls: last } }, { createdAt: desc }]`。
  - `src/components/account/{passkey-list,register-passkey-button}.tsx` —— 两阶段注册 UI；行内重命名；删除最后一把走差异化 confirm。
  - `src/lib/auth/two-factor-state.ts` — `shouldTwoFactorBeEnabled` 纯函数 + `recomputeTwoFactorEnabled(userId, tx)` 事务 helper，把 `User.twoFactorEnabled` 语义改为 `OR(TOTP, Passkey)`。
  - `src/lib/audit.ts` 新增 5 个 action：`webauthn.credential_added` / `webauthn.credential_renamed` / `webauthn.credential_removed` / `webauthn.login_succeeded` / `webauthn.tfa_succeeded`。
- **PR-3 2FA 挑战集成**
  - `src/lib/account/passkeys.ts` —— 两个 server action：`getPasskeyChallengeAction()`（仅返回当前用户已绑 credential 的 `allowCredentials`，避免向未登录的探测者暴露集合）和 `verifyPasskeyForCurrentSessionAction()`（验签后 bump counter / `lastUsedAt`，调用 `updateAuthSession({ tfa: 'verified' })` 清掉 `tfa_pending` JWT claim，audit `webauthn.tfa_succeeded`）。
  - `src/components/auth/{two-factor-passkey-form,two-factor-challenge-tabs}.tsx` —— 三种渲染模式：仅 Passkey / 仅 TOTP / 同时存在时手搓 tabs（项目目前没装 shadcn Tabs），双因子并存时 default 选 Passkey。
  - `src/app/[locale]/(auth)/login/2fa/page.tsx` —— 并行 `Promise.all([twoFactorSecret.findUnique, webAuthnCredential.count])` 决定 tab 集合。
- **PR-4 密码快捷登录入口**
  - `src/lib/webauthn/anonymous-challenge.ts` —— 用 httpOnly Cookie 暂存匿名 challenge，`path` 限定到 `/api/auth/webauthn/authenticate`，5 分钟 TTL，读后即清；不进数据库，免去了清理 cron。
  - `src/app/api/auth/webauthn/authenticate/options/route.ts` —— 匿名端点，`authLimiter` 按 IP 限流，`allowCredentials: []` 触发 Discoverable 流让浏览器 / OS 直接出 picker。
  - `src/app/api/auth/webauthn/authenticate/verify/route.ts` —— 反查 credentialId → 验签 → bump counter → `issueSsoSession({ userId, ip, userAgent })` 复用 RFC 0004 的 JWT-direct-encode 通路 → `attachSsoSessionCookie` → `{ ok: true, redirectTo }`；所有失败统一 401 generic 错误码避免 credentialId 探测。
  - `src/components/auth/sign-in-with-passkey-button.tsx` —— `browserSupportsWebAuthn()` 自门控，不支持就不渲染；成功后 `window.location.assign(redirectTo)` 硬跳转，让 middleware 在下一次请求看到新 cookie；`NotAllowedError`（用户取消）软失败。
  - `src/app/[locale]/(auth)/login/page.tsx` —— 改 async 接 `?callbackUrl=` 透传，密码表单下方分隔线 + Passkey 按钮；密码表单仍是首选 CTA。
- **PR-5 i18n + e2e + 文档收尾**
  - `messages/{en,zh}.json` —— `account.passkeys.*`、`auth.twoFactorChallenge.{tabs,passkey}.*`、`auth.login.passkey.*` 三组中英文 key。
  - `tests/e2e/webauthn-passkey.spec.ts` —— Playwright + Chrome DevTools `WebAuthn` 域虚拟 authenticator，覆盖 register / list / remove / passwordless 4 个核心 case；2FA tab 的 case 借用同一通路在 follow-up 补，主路径已闭环。
  - `docs/rfcs/0007-webauthn-passkey.md` §11 实施完成段回填（PR 文件清单 + 决策回填 + 首日观测指标）。
  - `package.json` 0.7.0 → 0.8.0；本 changelog 段。

### Changed

- `User.twoFactorEnabled` 语义从「TOTP 是否启用」扩为「TOTP 或 Passkey 任一存在」（PR-2）。Passkey 路径会在事务内调 `recomputeTwoFactorEnabled` 同步该列；TOTP 启用 / 关闭路径仍硬编码 true / false——已在 RFC §4.6 标注为已知 smell，留给后续清理。
- `/login` 页面从同步 RSC 改成 async，多接 `?callbackUrl=` 用于 passkey 成功后回跳（PR-4）。

### Migration / Operations

- 部署侧需要在生产环境显式注入 `WEBAUTHN_RP_ID` + `WEBAUTHN_ORIGIN` 才会激活整套 UI；env 不全时所有 passkey UI / 路由静默隐藏 / 404，等价回滚。
- Prisma migration `20260601100000_add_webauthn_credential/` 是纯加性变更，零停机。
- 各环境 `WEBAUTHN_RP_ID` 严格按域名分区：prod = `kitora.io`、staging = `staging.kitora.io`、dev = `localhost`、CN region = `kitora.cn`；同 RP ID 的 credential 不能跨环境验签，这是浏览器层的硬约束。

### Notes

- v0.8.0 是 Kitora 模板的第七个 RFC 落地版本，结束 RFC 0001–0007 的「foundation 七连」。下一步是 RFC 0008（待选）。
- Passkey 路径全程不动 `sessionVersion`：注册 / 删除 credential 都不踢已登录设备，与 RFC 0002 PR-1 admin 主动「全设备登出」语义解耦（§9 决策已确认）。
- WebAuthn 路径**不**进 `openapi/v1.yaml`：第一方登录页 / settings 页消费，第三方拿不到这条路径的实质用法（§9 决策已确认）。

## [0.7.0] — 2026-04-26

### 主题

**RFC 0006 — 中国区落地（工程层）**。把 RFC 0005 留下的 CN 接缝（provider factory `*-not-implemented` 抛错）填齐：阿里云 OSS / DirectMail / Alipay + WeChat Pay 完整支付链路 / Aliyun Redis 限流后端 / `/legal/data-rights` PIPL §44 入口 / `deploy-cn.yml` GitHub Actions 部署工作流 / `infra/aliyun/` Terraform 骨架。**ICP 备案 / 商户开户 / Aliyun 实名认证仍属 RFC 范围内但非代码型工作（PR-0），约 25 工作日，由团队推动**。

### Added

- **PR-2 邮件 + 对象存储 provider**
  - `src/lib/storage/aliyun-oss.ts` — `AliyunOssProvider implements StorageProvider`，`ali-oss` v6+ lazy import，v4 签名 + AES256 server-side encryption header。
  - `src/lib/email/aliyun-direct-mail.ts` — `sendAliyunDirectMail()` 包装 `@alicloud/dm20151123` 的 `singleSendMail`，verified sender + DKIM/SPF 走 DM 子域。
  - `sendEmail()` 在 `src/lib/email/send.ts` 加 `isCnRegion()` 分支，return shape `{ id: envId }` 与 Resend 兼容。
  - `src/lib/storage/index.ts` — `makeProvider()` 第一优先级判断 region，CN → AliyunOss，否则保持原 `DATA_EXPORT_STORAGE` 走 S3 / local。
  - `src/lib/region/providers.ts` — `getEmailProvider` / `getStorageProvider` 不再 throw，CN 分支返回正确 handle / 单例。
- **PR-3 schema + 支付**
  - Migration `20260601000000_add_cn_subscription_fields/`：`Subscription` 加 `provider` / `cnAgreementId` 列，`stripeSubscriptionId` relax 为 nullable + 复合索引。
  - Migration `20260601001000_add_billing_event_table/`：新增 `BillingEvent` 表（`provider` × `providerEventId` 复合唯一），仅服务 Alipay + WeChat 幂等去重；`StripeEvent` 不重命名（admin UI 共 4 处引用）。
  - `src/lib/billing/provider/alipay.ts` 完整 `alipay-sdk` v4 实现：`alipay.trade.page.pay` checkout、RSA2 验签、`passback_params` 回带、退款、`agreement.unsign`、`trade.create` 周期扣款。
  - `src/lib/billing/provider/wechat.ts` 完整 `wechatpay-node-v3` 实现：APIv3 Native pay 拿 `code_url`、AES-GCM 解密、`attach` 回带、退款。
  - `src/lib/billing/cn-price-config.ts` — Stripe priceId → CNY 金额映射，env 可覆盖默认。
  - `src/app/api/billing/alipay/notify/route.ts` + `src/app/api/billing/wechat/notify/route.ts` — 入站 webhook 路由：解析体 → 验签 → `BillingEvent` 复合唯一去重 → `Subscription` upsert → `recordAudit` + `enqueueWebhook` emit `subscription.created/updated`。
- **PR-4 限流 + 出境闸**
  - `src/lib/rate-limit.ts` 加 `buildAliyunRedisLimiter()`：`ioredis` + 自写 ZSET 滑窗（`ZREMRANGEBYSCORE` → `ZCARD` → `ZADD` → `PEXPIRE` 一次 MULTI 走完），CN region 走这条路径，GLOBAL 仍走 Upstash REST。
  - `scripts/audit-egress.ts` — 扫 `src/` + `scripts/` 出境域名黑名单（`amazonaws.com / upstash.io / resend.com / api.stripe.com / sentry.io / github.com / googleapis.com`），白名单 `kitora.cn / aliyuncs.com / alipay.com / weixin.qq.com / tenpay.com / dingtalk.com`；exempt 文件清单豁免 GLOBAL-only 模块。
  - `pnpm egress:check` npm script；默认 warn-only，`KITORA_REGION=CN` 或 `--strict` 时 exit 1。
- **PR-5 合规入口 + CN 部署 pipeline**
  - `src/app/[locale]/(marketing)/legal/data-rights/page.tsx` — PIPL §44 四权利菜单（查询 / 更正 / 删除 / 可携），CN-only，404 在 GLOBAL。中英文 i18n 完整。
  - `SiteFooter` CN 模式追加「个人信息权利」链接到 `/legal/data-rights`。
  - `.github/workflows/deploy-cn.yml` — GitHub OIDC → Aliyun RAM Role → `egress:check` 严格模式 → ACR 推镜像（带 `KITORA_REGION=CN` build-arg）→ ACK rollout → smoke `/api/health` → 失败 `kubectl rollout undo`。
- **PR-1 Terraform 骨架**（不可 apply，待 PR-0 备案后激活）
  - `infra/aliyun/` 14 个 `.tf` 文件：`main.tf` / `variables.tf` / `outputs.tf` / `versions.tf` + `modules/{vpc, security-groups, rds, redis, oss, sls, ack, slb-waf, kms}/`。
  - 每个 module 头部标 RFC 0006 §X 引用；resource body 全 `# TODO` 注释，output 全 stub `null` 让顶层 typecheck 通过。
- **依赖**：`alipay-sdk@^4.14.0` · `wechatpay-node-v3@^2.1.7` · `ali-oss@^6.23.0` · `@types/ali-oss@^6.23.3` · `@alicloud/dm20151123@^1.9.2` · `@alicloud/openapi-client@^0.4.15` · `ioredis@^5.10.1`。
- **env**（17 项可选）：`ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET` / `ALIYUN_OSS_BUCKET` / `ALIYUN_OSS_REGION` / `ALIYUN_OSS_ENDPOINT` / `ALIYUN_DM_ACCOUNT_NAME` / `ALIYUN_DM_ENDPOINT` / `ALIYUN_REDIS_URL` / `ALIPAY_APP_ID` / `ALIPAY_PRIVATE_KEY` / `ALIPAY_PUBLIC_KEY` / `ALIPAY_GATEWAY` / `CN_PUBLIC_API_URL` / `WECHAT_PAY_MCH_ID` / `WECHAT_PAY_APIV3_KEY` / `WECHAT_PAY_MERCHANT_PRIVATE_KEY` / `WECHAT_PAY_MERCHANT_SERIAL_NO` / `WECHAT_PAY_APP_ID`。GLOBAL 部署不设这些，行为零变化。

### Changed

- README Multi-region 表 CN 行从「⏳ RFC 0006 落地」翻为「✅ 工程层完成；备案 / 商户开户进行中」；顶部段加 RFC 0006 引用 + `deploy-cn.yml` 流程提示 + 备案非代码工期说明（25 工作日）。
- 路线图加一条 RFC 0006 完成项。
- `docs/deploy/cn.md` 由「待办清单」改为「已交付清单」，明示 RFC 0006 工程部分完成 / PR-0 备案部分仍在线下推进。
- `docs/rfcs/0006-cn-region-deployment.md` 状态从 **Draft** → **Implemented（工程层 v0.7.0）**；§14 实施完成回填详细 PR 清单 + §12 待决策项的拍板（Alipay+WeChat 双开 / WeChat 仅 Native / `audit-egress` CI 阻断 / Sentry self-hosted）。

### Migration notes

GLOBAL stack 升级（不接 CN）：

```sh
pnpm install                # 拉 7 个新 deps
pnpm db:generate            # Prisma client 认识新 Subscription 字段与 BillingEvent
pnpm prisma migrate deploy  # 应用 2 个新迁移（纯加列 / 加表，秒级）
```

应用层无破坏性变更——`Subscription` 旧行 `provider` 默认 `'stripe'`，`stripeSubscriptionId` 仍 `@unique` 非空场景行为不变。

CN stack 激活（待 PR-0 完成后）：

1. 走完 ICP 备案 / 公安部备案 / Aliyun 实名 / `kitora.cn` 域名注册 / Alipay + WeChat Pay 商户号开通；
2. 取消 `infra/aliyun/modules/*/main.tf` 各 module 的 `# TODO` 注释段，配 OSS state backend bucket，`terraform plan` → `terraform apply`；
3. 拿 Terraform output 填进 GitHub repo secrets（`ALIYUN_ACR_OIDC_ROLE_ARN` / `ACK_CLUSTER_ID`）+ Aliyun KMS-backed ACK secret-binding（`DATABASE_URL` / `AUTH_SECRET` / 17 个 ALIYUN\_\*）；
4. 推 tag `cn-v0.7.0` 触发 `.github/workflows/deploy-cn.yml`，第一次 rollout 上线。

详见 `docs/rfcs/0006-cn-region-deployment.md` §3 / §7 / §11 与 `docs/deploy/cn.md`。

---

## [0.6.0] — 2026-04-26

### 主题

**RFC 0005 — 数据驻留 / 多 region（Share-Nothing）**。把 codebase 改造成可以在不同 region（GLOBAL / CN / EU）独立部署、彼此 share-nothing 的形态。CN 实际部署留给 RFC 0006。

### Added

- `Region` 枚举（`GLOBAL` / `CN` / `EU`）+ `User.region` / `Organization.region` / `AuditLog.region` 三列；`User.email` 唯一索引升级为 `(email, region)` 复合唯一；`AuditLog` 加 `(region, createdAt)` 复合索引（合规报表 hot path）。Migration 名 `20260427000000_add_region_columns`，全加法 + GLOBAL backfill。
- `src/lib/region.ts` — `currentRegion()` / `isCnRegion()` 唯一入口；`KITORA_REGION` 优先，`REGION` 一个版本兼容并发 deprecation warning。
- `src/lib/region/providers.ts` — email / storage / billing 的 region-aware factory。CN 分支故意 throw `not-implemented`，逼 RFC 0006 把 Aliyun 三件套配齐才能上线 CN stack。
- `src/lib/region-startup-check.ts` + `src/instrumentation.ts` — 启动时 panic 校验 DB region 与进程 region 一致，防止 CN stack 误连 GLOBAL DB。
- `src/middleware.ts` 加 region-mismatch 守卫；`/region-mismatch` i18n 提示页（en / zh）。
- 写库入口（signupAction / SSO JIT / SCIM POST / `recordAudit`）全部自动 stamp `region = currentRegion()`。
- 包装 `@auth/prisma-adapter`：`getUserByEmail` / `createUser` 走 `(email, region)` 复合 unique，确保 OAuth 流也走对路径。
- 跨 region 一致性校验：邀请创建 / 接受、SCIM token 校验、Org 更新（schema 不暴露 region 列 + 注释明示）。
- `Dockerfile` 加 `ARG KITORA_REGION` build-time 注入；新增 `docker-compose.cn.yml` / `docker-compose.eu.yml` 占位（`docker-compose.yml` 保持向后兼容，附 GLOBAL 注释）。
- `docs/deploy/{global,cn,eu}.md` 三份部署 runbook；README 顶部 Multi-region 段。
- `tests/e2e/region.spec.ts` — 5 个 case 覆盖复合唯一 / 跨 region 共存 / 删一边不影响另一边 / `region` 列 stamp / mismatch 页渲染。

### Changed

- `src/env.ts` — 新增 `KITORA_REGION: z.enum(['GLOBAL','CN','EU']).optional()`；旧 `REGION: z.enum(['global','cn']).optional()` 保留作为 alias，命中时 logger.warn。**v0.8 移除**。
- `src/lib/billing/provider/index.ts` 内部从 `env.REGION` 切到 `currentRegion()`，分支命中 Prisma `Region` 枚举值。
- `src/components/marketing/site-footer.tsx` 与 `src/app/[locale]/(marketing)/icp/page.tsx` 切到 `isCnRegion()`。
- `prisma/seed.ts` — `findUnique({ email })` 改 `(email, region)` 复合 unique；新增 `SEED_REGION` env 支持非默认 region 本地播种。

### Deprecated

- `REGION` 环境变量（小写枚举形式）。v0.6 + v0.7 接受作为 alias，**v0.8 移除**。请改用 `KITORA_REGION`（大写枚举值）。

### Migration notes

新部署或现有 GLOBAL stack：

```sh
pnpm prisma migrate deploy
docker build --build-arg KITORA_REGION=GLOBAL -t kitora:global .
```

详见 `docs/deploy/global.md`。CN / EU 部署 stub 见 `docs/deploy/cn.md` / `docs/deploy/eu.md`。

---

## [0.5.0] — 2026-04-25

RFC 0004 — SSO（SAML + OIDC + SCIM）落地。详细 commit 列表见 `git log v0.4.0..v0.5.0`。

## [0.4.0]

RFC 0003 — Outbound webhooks + OpenAPI v1。`git log v0.3.0..v0.4.0`。

## [0.3.0]

RFC 0002 — Security & Compliance（active sessions / 2FA / data export / 删除宽限期 / org 2FA 强制）。`git log v0.2.0..v0.3.0`。

## [0.2.0]

RFC 0001 — Organizations / Memberships / Roles。`git log v0.1.0..v0.2.0`。

## [0.1.0]

初始项目骨架：Next.js App Router + Prisma + Auth.js + Stripe + i18n + Sentry。

[0.7.0]: https://github.com/your-org/kitora/releases/tag/v0.7.0
[0.6.0]: https://github.com/your-org/kitora/releases/tag/v0.6.0
[0.5.0]: https://github.com/your-org/kitora/releases/tag/v0.5.0
[0.4.0]: https://github.com/your-org/kitora/releases/tag/v0.4.0
[0.3.0]: https://github.com/your-org/kitora/releases/tag/v0.3.0
[0.2.0]: https://github.com/your-org/kitora/releases/tag/v0.2.0
[0.1.0]: https://github.com/your-org/kitora/releases/tag/v0.1.0
