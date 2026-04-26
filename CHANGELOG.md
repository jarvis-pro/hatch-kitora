# Changelog

本文档遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。每个 minor 版本对应一个 RFC 的落地，详细背景见 `docs/rfcs/`。

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
