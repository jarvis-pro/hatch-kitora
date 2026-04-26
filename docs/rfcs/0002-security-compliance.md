# RFC 0002 — 安全合规进阶（2FA / Active Sessions / 数据导出 / 注销宽限）

| 状态     | **Draft**（2026-04-26）                                         |
| -------- | --------------------------------------------------------------- |
| 作者     | Jarvis                                                          |
| 创建于   | 2026-04-26                                                      |
| 影响版本 | 0.2.0 → 0.3.0（非破坏性，但有数据迁移）                         |
| 关联     | RFC 0001 §10 占位 · README 路线图 · Phase「security-hardening」 |

---

## 1. 背景与目标

Kitora 现有认证依赖 Auth.js v5 + JWT + `User.sessionVersion`：登出全部账号是一个原子 bump，但缺乏**单条会话粒度**与**双因子保护**；GDPR DSAR 与「右被遗忘」尚无产品化入口；账号注销是即时硬删，无后悔药。这四块能力是「企业可用」红线，做完才能向 SMB / 中型客户拿单。

**目标**：

- **Active Sessions**：每条 JWT 关联 `DeviceSession` 行；用户能看到所有活跃设备（UA / 大致 IP / 最近活跃时间）并按行撤销。
- **2FA**：TOTP（RFC 6238）+ 一次性 backup codes；OAuth / Credentials 登录后统一拦截 2FA 校验；OWNER 可对自家 org 打开「全员强制 2FA」开关。
- **GDPR 数据导出**：用户一键打包自己的 PII zip；OWNER 一键打包整个 org 的元数据 zip；异步生成 + 邮件下载链接。
- **账号注销宽限期**：用户提交注销 → 进入 30 天 `PENDING_DELETION` 态，期间随时可撤销；到期 cron 真删（仍走级联 + 保留 AuditLog）。

**非目标**：

- WebAuthn / FIDO2 硬件密钥（留给 RFC 0006）。
- 短信 / 邮箱二次验证（明确不做：弱因素，给用户错误的安全感）。
- 自动「可疑登录」检测（异地 / 风控）；不做基线，留给后续。
- 第三方 DSAR 合规对接（OneTrust 等），先做**自助**导出。
- 公司级数据保留策略 / Legal Hold（由 RFC 0007 覆盖）。

---

## 2. 核心设计

### 2.1 Active Sessions（JWT + DeviceSession 表）

**为什么不切 DB session strategy**：现有 jwt callback 已经做了 `sessionVersion` 的 DB 反查（`src/lib/auth/index.ts`），切到 database session 要重写 middleware 鉴权链路、Edge 运行时不能直接查 Prisma 的限制还得绕。代价大、收益小。

**做法**：每次签发 JWT 时附 `sid` claim（base64url 32 字节随机），库内存 `sha256(sid)`。jwt callback 在已有的 sessionVersion 校验基础上多查一次 `DeviceSession` 行，行不存在或 `revokedAt` 非空就返回 `null`（等价于强制重登）。

```prisma
model DeviceSession {
  id         String    @id @default(cuid())
  userId     String
  sidHash    String    @unique          // sha256(sid)
  userAgent  String?                    // 原始 UA 字符串，UI 端解析
  ip         String?                    // 仅记录创建时 IP；不更新
  lastSeenAt DateTime  @default(now())
  createdAt  DateTime  @default(now())
  revokedAt  DateTime?

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, revokedAt])
  @@index([lastSeenAt])
}
```

#### `lastSeenAt` 写入节流

每个请求都更新 `lastSeenAt` 会让这一行变成热点写。规则：仅当 `now - lastSeenAt > 60s` 才写，且用 `prisma.deviceSession.updateMany({ where: { sidHash, lastSeenAt: { lt: cutoff } }, ... })`，乐观无锁；高并发下大多数请求落到 `0 rows affected` 是正常的。

#### 撤销路径

- **单条撤销**：UI 调用 `revokeSession(sidHash)` → 设 `revokedAt = now()`；当前 cookie 持有者下次请求时被 jwt callback 拒绝（401 → 登录页）。
- **登出全部**：保留现有 `User.sessionVersion` bump 路径，但**额外**写一条 SQL 把所有未撤销 session 标 `revokedAt`，确保 Active Sessions 列表立即清空（不止于 token 失效）。
- **当前会话标记**：列表里给当前请求那条加 `current: true`（后端比较 sidHash），UI 上禁用「撤销」按钮以免自杀。

#### Edge 运行时

Edge config（`src/lib/auth/config.ts`）不能查 DB——保持现状只看 JWT 是否在期、role 校验；DeviceSession 的 sid 校验放在 Node 侧 jwt callback。Edge 偶发缓存命中时，最坏情况是被撤销的 session 仍能通过 middleware 走到 Node，到了 Node 立刻 401，**无安全暴露**。

### 2.2 2FA（TOTP + Backup Codes + Org 强制策略）

#### Schema

```prisma
model TwoFactorSecret {
  userId         String    @id
  // AES-256-GCM 加密；密钥派生自 AUTH_SECRET 与 userId（HKDF），轮换由
  // env 变量切换；详见 §6 安全细节。
  encSecret      Bytes
  enabledAt      DateTime?              // null = 已开始注册但未确认
  // 一次性 backup codes：10 个，sha256 存；用一个删一个（不写"used"标记，
  // 避免暴露剩余数量给攻击者）。重新生成 = 全删 + 重发 10 个。
  backupHashes   String[]               @db.Text
  lastUsedAt     DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

`User` 上加一个**冗余**布尔 `twoFactorEnabled @default(false)`：避免每次 jwt callback / wall 检查都 join `TwoFactorSecret`。事务里与 `enabledAt` 同写。

#### 注册流程

1. 用户进 `/settings/security` → 点「Enable 2FA」。
2. 服务端：生成 20 字节 base32 secret + 10 个 backup codes；落库 `enabledAt = null`；把 secret + otpauth URI 返回。
3. UI 渲染二维码（`qrcode` lib，client-side render），让用户用 Authenticator 扫。
4. 用户输入 6 位 TOTP 码确认 → 服务端校验通过 → 标 `enabledAt = now()`，置 `User.twoFactorEnabled = true`，**展示 backup codes 一次**（强制下载 / 复制确认勾）。
5. 写 audit `2fa.enabled`，发邮件「2FA 已开启」（防被劫持启用）。

#### 登录拦截

Credentials 与 OAuth 都要走二步：

- 现有 Credentials `authorize` 不变（成功就返回 user）。但 jwt callback 检测到 `user.twoFactorEnabled && !token.tfa_passed` 时，把 token 标记为 `tfa_pending = true`，前端 `auth()` 检测后跳 `/login/2fa`。
- `/login/2fa` 页接受 6 位 TOTP **或** 8 位 backup code；通过后服务端 update token claims `tfa_passed = true`（用 `unstable_update`），下次请求生效。
- OAuth 同理：`signIn` callback 不挡（让账号 link 流程走完），由 jwt callback 接管 tfa_pending 标记。
- Trusted device：v1 不做「记住此设备 30 天」。算复杂度收益不高，等用户提需求。

#### 备份恢复

- backup code 用一次销毁；剩 ≤ 3 个时 banner 提醒重新生成。
- 全丢光 + secret 也丢的极端情况：v1 不提供自助恢复（防社工）。走 `/support` 表单 → 手工核身 → 平台 admin 在后台 `/admin/users/:id` 点「Reset 2FA」（写 audit `2fa.disabled`，actor = admin）。
- 所有 2FA 相关动作（启用 / 关闭 / 重发 backup / admin reset）发邮件通知账号邮箱。

#### Org 强制开关

```prisma
model Organization {
  // ... 现有字段
  require2fa Boolean @default(false)
}
```

OWNER 在 `/settings/organization` 勾选「Require 2FA for all members」：

- 写入即生效；写 audit `org.2fa_required_changed`。
- 影响范围：所有 server action / RSC / 受保护路由进入前 `assertOrg2faCompliance(activeOrg, user)`：org 要求 2FA 且 user 未开启 → 抛 `OrgPolicyViolationError`，被边界 catch 后跳 `/onboarding/2fa-required`（强制开 2FA 才能继续；可切到别的 org，但**不能继续操作本 org**）。
- 邀请新成员：邮件里写明「This organization requires 2FA」；接受邀请 → 跳 2FA 设置页。
- 不溯及既往清算：开启策略时不踢现有未启用成员，仅在他们下次操作时挡住。

### 2.3 GDPR 数据导出（user + org，异步打包）

#### 为什么异步

打包用户全量数据可能涉及 audit log 大表 + JSON 序列化，同步会拖死 web request。架构上引入第一个**后台 job**——但**不引入 job queue 系统**。先用最小化方案：

```prisma
model DataExportJob {
  id          String           @id @default(cuid())
  userId      String                          // 谁发起的
  orgId       String?                         // null = user 维度；非 null = org 维度
  scope       DataExportScope
  status      DataExportStatus @default(PENDING)
  // 输出文件相对路径或 S3 key；由 env DATA_EXPORT_STORAGE 决定
  storagePath String?
  sizeBytes   Int?
  // 下载链接 7 天过期，过期后定时任务清文件
  expiresAt   DateTime?
  errorMessage String?
  createdAt   DateTime         @default(now())
  startedAt   DateTime?
  completedAt DateTime?

  @@index([userId])
  @@index([orgId])
  @@index([status])
  @@index([expiresAt])
}

enum DataExportScope {
  USER
  ORG
}

enum DataExportStatus {
  PENDING
  RUNNING
  COMPLETED
  FAILED
  EXPIRED
}
```

#### 执行通道

不要专门起 worker container。用 Vercel Cron / Fly cron 每分钟跑一次 `scripts/run-export-jobs.ts`：

1. 抢一条 `PENDING` 行（`updateMany` + `where: status=PENDING` + `LIMIT 1` 的乐观抢占模式）。
2. 跑导出：`zip` 流式写出 → 上传到 storage → 写 `COMPLETED + storagePath + expiresAt = now + 7d`。
3. 发邮件，附下载链接（`/api/exports/[jobId]/download`，鉴权后 302 到 signed URL 或本地流）。
4. 失败：`FAILED + errorMessage`，UI 展示重试按钮。

storage abstraction 已在 `src/lib/billing/provider/` 有先例；新建 `src/lib/storage/`，先实现 `LocalFsProvider`（dev）+ `S3Provider`（prod）。

#### 导出内容

User 维度 zip 结构：

```
kitora-export-{userId}-{yyyymmdd}.zip
├── manifest.json              # 版本、生成时间、文件清单
├── profile.json               # User 主表 + locale
├── accounts.json              # OAuth 绑定（provider + providerAccountId）
├── memberships.json           # 我加入的 org 列表 + 角色 + joinedAt
├── api-tokens.json            # 元数据（name / prefix / lastUsedAt），无 hash 无明文
├── audit-as-actor.json        # AuditLog where actorId = me
├── device-sessions.json       # 历史 + 当前设备会话（脱 sidHash）
├── data-exports.json          # 我之前的导出请求
└── README.md                  # 字段说明 + GDPR 主体权利说明
```

Org 维度 zip（OWNER only）：

```
kitora-org-export-{slug}-{yyyymmdd}.zip
├── manifest.json
├── organization.json          # org 基本信息（含 stripeCustomerId 替换为占位）
├── members.json               # 成员列表（id / email / role / joinedAt）
├── invitations.json           # pending + 历史（脱 tokenHash）
├── api-tokens.json            # org-scoped token 元数据
├── subscriptions.json         # 订阅历史 / 当前状态
├── audit-org-scope.json       # AuditLog where orgId = org.id
└── README.md
```

#### 隐私脱敏

明确**不**写入：`passwordHash` / `tokenHash` / `sidHash` / `encSecret` / `backupHashes` / Stripe 真实 customerId 与 priceId（替换成 plan slug）。manifest.json 列出每个文件的 schema 版本，便于将来字段演化时机器读取。

#### 限频

每个 user 24h 内 1 次 user 维度导出；每个 org 24h 内 1 次 org 维度导出。命中限频返回 429 + 下次可用时间。

### 2.4 账号注销 30 天宽限期

#### 状态机

```prisma
enum UserStatus {
  ACTIVE
  PENDING_DELETION   // 等待硬删；deletionScheduledAt 必填
}

model User {
  // ... 现有字段
  status                 UserStatus @default(ACTIVE)
  deletionScheduledAt    DateTime?
  deletionRequestedFromIp String?
}
```

#### 提交注销

用户在 `/settings/account/delete` 走二次确认（输入邮箱 + 密码 / 当前 TOTP）：

1. **前置校验**：用户在 ≥1 个**多人** org 是 OWNER → 拒绝，强制先转让 / 删 org（业务角度不能让 OWNER 突然消失，已经在 RFC 0001 定的逻辑里）。Personal Org 不阻塞，因为没有别的成员。
2. 写 `status = PENDING_DELETION` / `deletionScheduledAt = now() + 30d`。
3. **bump `sessionVersion` + 撤销所有 DeviceSession**（业务上账号已经"准死"，不该让任何 token 继续）。
4. 写 audit `account.deletion_scheduled`。
5. 发邮件「Your account will be permanently deleted on 2026-05-26. [Cancel]」附登录链接。
6. 跳到「已计划注销」页，提示 30 天内任意时刻登录可撤销。

#### 撤销路径

`PENDING_DELETION` 用户登录**允许**（否则就回不来了）。登录后所有页面顶部红 banner：「Your account is scheduled for deletion on …. Cancel deletion?」。点撤销 → `status = ACTIVE` + 清 `deletionScheduledAt` + 写 audit `account.deletion_cancelled`。

期间用户**只能**操作账号设置（恢复 / 撤销）；其它路由（dashboard / org / API）一律重定向到撤销页。这是为了让数据保持冻结状态——避免「都决定删了还在产生新数据」的尴尬。

#### 到期硬删

`scripts/run-deletion-cron.ts` 每天跑一次：

1. 拉所有 `PENDING_DELETION AND deletionScheduledAt < now()`。
2. 对每个 user：
   - 检查 OWNER 状态：如果在 30 天内被加进了某个 org 当 OWNER（极端边角），跳过 + 通知平台 admin 介入（不会发生，因为他们登录后被锁在删除页，但写防御代码）。
   - `prisma.user.delete` 触发级联：Account / Session / DeviceSession / TwoFactorSecret / Membership（自动删）+ Personal Org（如果 Personal Org 上没别的成员）。
   - 多成员 org 的 OWNER：上一步已经被前置校验挡住，到这里不会出现。
   - **保留** AuditLog（actorId 已是 nullable，无 FK，孤立行天生支持）。
3. 写 audit `account.deleted`（actor=null + target=userId）。

### 2.5 公开 API 影响

`GET /api/v1/me` 响应增加 `twoFactorEnabled: boolean` 与 `pendingDeletion: { scheduledAt: string } | null`。

新增端点：

```
GET    /api/v1/me/sessions              → DeviceSession 列表（脱 sidHash）
DELETE /api/v1/me/sessions/{id}         → 撤销单条
POST   /api/v1/me/sessions/revoke-all   → 撤销除当前外全部
GET    /api/v1/me/exports               → 我的导出任务列表
POST   /api/v1/me/exports               → 触发新导出（scope=USER）
GET    /api/v1/me/exports/{id}/download → 下载链接（302）
POST   /api/v1/orgs/{slug}/exports      → 触发 org 导出（OWNER）
GET    /api/v1/orgs/{slug}/exports      → org 维度导出任务列表（OWNER）
```

2FA 启用 / 关闭走 server action，不在公开 API 暴露——避免 API token 自助开 / 关 2FA 这种自相矛盾。

---

## 3. 数据模型变更总表

| 表 / 枚举          | 变更                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User`             | + `twoFactorEnabled` / `status` / `deletionScheduledAt` / `deletionRequestedFromIp`                                                                                                                                                                      |
| `Organization`     | + `require2fa`                                                                                                                                                                                                                                           |
| `DeviceSession`    | 新表                                                                                                                                                                                                                                                     |
| `TwoFactorSecret`  | 新表                                                                                                                                                                                                                                                     |
| `DataExportJob`    | 新表                                                                                                                                                                                                                                                     |
| `UserStatus`       | 新枚举                                                                                                                                                                                                                                                   |
| `DataExportScope`  | 新枚举                                                                                                                                                                                                                                                   |
| `DataExportStatus` | 新枚举                                                                                                                                                                                                                                                   |
| `AUDIT_ACTIONS`    | + `2fa.enabled` / `2fa.disabled` / `2fa.backup_regenerated` / `session.revoked` / `session.revoked_all` / `account.export_requested` / `account.deletion_scheduled` / `account.deletion_cancelled` / `org.export_requested` / `org.2fa_required_changed` |

---

## 4. 迁移计划（拆 4 个 PR，每个独立可回滚）

### PR-1 Active Sessions（schema + 列表 + 撤销）

- 加 `DeviceSession` 表 + 索引。
- jwt callback 新增 sid 注入与校验；登录路径写 DeviceSession 行。
- `requireUser()` 顺手把 sidHash 透出，给「current session」标记用。
- `/settings/security` 新增 "Active sessions" 区块（设备 / IP / lastSeenAt / 撤销）。
- 既有 `signOutEverywhere()` server action 多写一行：`updateMany revokedAt`。
- e2e：登录两次 / 列出两条 / 撤销 / 第二条立即 401。

通过点：现有 sessionVersion 路径不受影响；老用户首次访问时没有 DeviceSession 行——jwt callback 见 `token.sid` 为空时**懒补**一条（迁移期允许），等所有人都重登一次后行为统一。

### PR-2 2FA（user 级 only）

- 加 `TwoFactorSecret` + `User.twoFactorEnabled`。
- 登录拦截：`tfa_pending` 在 jwt token 上的状态机；`/login/2fa` 页。
- `/settings/security/2fa`：注册 / 验证 / 重生 backup / 关闭。
- `/admin/users/:id` 加 "Reset 2FA"（OWNER → 平台 admin 高危按钮）。
- 邮件模板：`2fa-enabled` / `2fa-disabled` / `2fa-reset-by-admin`。
- e2e：开启 → 退出 → 重登 → 拦截 → TOTP 通过 → 进 dashboard；backup code 一次性。

### PR-3 GDPR 导出（user + org）

- 加 `DataExportJob` + `src/lib/storage/`（`LocalFsProvider` + `S3Provider`）。
- `scripts/run-export-jobs.ts` cron。
- `/settings/account/export` UI（user 维度）。
- `/settings/organization/export` UI（OWNER 维度）。
- 限频中间件：复用现有 ratelimit 基础（1 / 24h）。
- 导出 manifest 版本字段 = `1.0`，未来 schema 演化时 bump。
- e2e：触发 → 查 PENDING → 跑 cron → 收到邮件 → 下载 zip → 解压验内容。

### PR-4 注销宽限期 + Org 级 2FA 强制

- 加 `User.status` / `deletionScheduledAt` / `deletionRequestedFromIp`；`UserStatus` 枚举。
- `Organization.require2fa`。
- `assertOrg2faCompliance` + `/onboarding/2fa-required` 拦截页。
- `/settings/account/delete` 二次确认页 + 撤销页。
- `scripts/run-deletion-cron.ts` 每日跑。
- `requireUser()` 加分支：`PENDING_DELETION` 用户路由白名单（仅 `/settings/account/cancel-deletion` + 登出）。
- e2e：注销 → 登录后 banner → 撤销 → 数据完整 / 新一次注销 → 跳 `deletionScheduledAt = now()` → 跑 cron → 数据消失，audit 仍在。

回滚策略：PR-1 / PR-2 / PR-3 任意点都能直接回退（schema 删表即可）；PR-4 涉及 `User.status` 字段填充，回退前先把所有 `PENDING_DELETION` 标回 `ACTIVE` 并归零 `deletionScheduledAt`。

---

## 5. 权限矩阵补充

延续 RFC 0001 §4 的格式：

| Action                             | OWNER | ADMIN | MEMBER | SELF |
| ---------------------------------- | :---: | :---: | :----: | :--: |
| 看自己的 active sessions           |       |       |        |  ✓   |
| 撤销自己的 session                 |       |       |        |  ✓   |
| 启用 / 关闭自己的 2FA              |       |       |        |  ✓   |
| 重生自己的 backup codes            |       |       |        |  ✓   |
| 触发自己的数据导出                 |       |       |        |  ✓   |
| 计划 / 撤销自己的注销              |       |       |        |  ✓   |
| 切换 org `require2fa`              |   ✓   |       |        |      |
| 触发 org 数据导出                  |   ✓   |       |        |      |
| 平台 admin: Reset 用户 2FA         |   —   |   —   |   —    |  —   |
| 平台 admin: 立即清除 deletion 计划 |   —   |   —   |   —    |  —   |

平台 admin（`User.role = ADMIN`）依然拥有 RFC 0001 §4 描述的「OWNER 等价 + 救火」权限，并为本 RFC 新增的两条单独留 audit 行。

---

## 6. 安全细节

### 2FA secret 加密

`TwoFactorSecret.encSecret` 用 AES-256-GCM 加密；密钥派生：

```
key = HKDF(secret = AUTH_SECRET, salt = userId, info = "kitora-2fa-v1", L = 32)
```

理由：

- 不引入新 KMS / env 变量；`AUTH_SECRET` 已是事实主密钥。
- userId 当 salt 让每行用独立子密钥，单行 secret 泄露不污染全表（攻击者拿到一行密文 + AUTH_SECRET 才能解，但拿到 AUTH_SECRET 等于全盘失守，所以这层主要防的是 DB dump 单独泄露）。
- 轮换路径：env 加 `AUTH_SECRET_OLD`；新写用 v2 key（`info = "kitora-2fa-v2"`），读时尝试 v2 → fallback v1，迁移完成后下线 v1。

### sid / backup code 强度

- sid：32 字节 CSPRNG → base64url，44 字符。
- TOTP secret：20 字节 base32（标准）。
- backup codes：5 字节 CSPRNG → base32，8 字符（去掉易混 0/O/1/I），用 `-` 切成 `XXXX-XXXX`。

### 邮件副作用

所有「准坏事」（启用 / 关闭 2FA、计划注销、单设备登录到陌生地区）都发账号邮箱。邮件签名链接限频 1/分钟，避免被攻击者拿 API 当 spam 入口。

### Audit IP

DeviceSession.ip 仅记录创建时一次（避免移动设备网络切换导致 audit 噪声）。AuditLog 已经记 IP，不重复。

---

## 7. 可观测性 / Metrics

`/api/metrics` 新增：

```
kitora_device_sessions_active            # gauge
kitora_users_with_2fa_total              # gauge
kitora_orgs_require_2fa_total            # gauge
kitora_data_export_jobs_total{status}    # counter / gauge by status
kitora_data_export_zip_bytes_bucket{...} # histogram
kitora_users_pending_deletion            # gauge
kitora_account_deletions_total           # counter（cron 真删时 +1）
kitora_2fa_login_failures_total          # counter（连续失败 → 抓暴破）
```

审计事件见 §3 表末（10 条新 action）。`AUDIT_ACTIONS` 是 `as const` 数组，加完后 Type 自动收缩，UI i18n 漏键会被 typecheck 抓到。

---

## 8. 风险与对策

| 风险                                             | 对策                                                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `lastSeenAt` 高并发热点写                        | 60s 节流 + `where lastSeenAt < cutoff` 乐观更新；命中率 < 5% 在意料中                                                  |
| 2FA secret 加密轮换出错导致全员锁号              | 双密钥读 + 灰度迁移；`AUTH_SECRET_OLD` 不删超过两个版本周期；上线前对全量行做一次 re-encrypt dry-run 验证可解密率 100% |
| backup code 全用光 + secret 丢失                 | v1 走平台 admin 手工恢复（写 audit），UI 引导用户在 enable 时强制下载；剩 ≤3 时 banner 提醒                            |
| OAuth 第三方账号被劫持后绕过 2FA                 | 所有 provider（GitHub / Google）登录都强制走 2FA 拦截，jwt callback 一处统一判断；不留 OAuth 旁路                      |
| 导出 zip 含敏感字段（hash / Stripe customerId）  | manifest 走白名单 schema，加 e2e 用 fixture 校验：解压后用 grep 跑黑名单字段必须 0 命中                                |
| 导出 cron 抢占冲突 / 漏跑                        | `updateMany ... status=PENDING` 限 1 行抢占；超时 (`startedAt < now-15min` 仍 RUNNING) 视为 stuck，一并回收            |
| 30 天宽限期内用户被刷邀请进 org 当 OWNER         | `PENDING_DELETION` 用户路由白名单只允许 `/settings/account/*`，没法接受邀请；防御性脚本里再 double check               |
| Personal Org 在 user 删除时不释放 stripeCustomer | 级联前 hook 调 `stripe.customers.del`（best-effort + 失败写 audit），避免 Stripe 侧账号孤儿                            |
| Org `require2fa` 开启后管理员自己未开导致自锁    | server action 入口检查：调用方未启用 2FA 时拒绝开启该开关，提示「先给自己开启 2FA」                                    |
| Edge 缓存的 JWT 在 sid 撤销后短暂仍可达          | 影响仅限于 middleware 层（无敏感操作），到 Node 立即 401；可接受                                                       |
| 中国区合规与 GDPR 字段差异                       | manifest 走通用 schema，区域差异由 RFC 0005 「中国区企业资质」覆盖；本 RFC 不分区                                      |

---

## 9. 工作量估算

| PR   | 内容                                | 估时   |
| ---- | ----------------------------------- | ------ |
| PR-1 | Active Sessions（schema + UI）      | 1.5 天 |
| PR-2 | 2FA（user 级 + 邮件 + admin reset） | 3 天   |
| PR-3 | GDPR 导出（user + org + cron）      | 2.5 天 |
| PR-4 | 注销宽限期 + org 强制 2FA           | 2 天   |
| 合计 |                                     | ~9 天  |

---

## 10. 评审决策（2026-04-26 已定稿）

- [x] **Active Sessions 实现** — JWT + DeviceSession 表（不切 DB session strategy）。理由：现有 jwt callback 已经做 sessionVersion DB 反查，加一个 sidHash 索引查询代价可忽略；切 strategy 要重写 middleware 与 Edge 鉴权，收益不抵成本。
- [x] **2FA 覆盖范围** — user 级 + Org 强制开关。理由：企业客户问「能不能强制」是常见售前问题，schema 上加一个 boolean、运行时一处 wall 检查就够；不做反而需要二次 RFC。
- [x] **数据导出口径** — user + org（OWNER 可导出整个 org）。理由：GDPR DSAR 主要是 user 维度，但「让我把 org 数据搬走」是离职 / 转产品的常见诉求，做了能直接回答 SOC 2 自评清单；脱敏白名单已确保安全。
- [x] **注销宽限期** — 30 天。理由：业界主流（GitHub / Slack / Notion 都是 30）；用户后悔窗口足够，slug / 邮箱即时释放收益不抵风险。

待评审（暂保留默认建议）：

- [ ] **Trusted device「记住此设备 30 天」** — v1 不做。等用户反馈再加；列表里相关 UA 已经能看到，频繁登录痛点不显著。
- [ ] **WebAuthn 替代 / 并存 TOTP** — 留 RFC 0006。不和 TOTP 互斥，先把 TOTP 做完是更稳的拼图。

---

## 11. 后续 RFC 占位

- RFC 0003 — 出站 Webhook & OpenAPI 文档站（开发者生态）
- RFC 0004 — SSO（SAML / OIDC / SCIM）
- RFC 0005 — 中国区企业资质 / 多 ICP 备案
- RFC 0006 — WebAuthn / Passkey
- RFC 0007 — 数据保留策略 / Legal Hold / SOC 2 审计准备
