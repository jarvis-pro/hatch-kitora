# RFC 0007 — WebAuthn / Passkey（双轨：2FA 因子 + 密码快捷登录）

| 状态     | **Implemented**（2026-04-26 落地于 v0.8.0）                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 作者     | Jarvis                                                                                                                                                                                                       |
| 创建于   | 2026-04-26                                                                                                                                                                                                   |
| 影响版本 | 0.7.0 → 0.8.0（非破坏性，新增表 + 新增公开端点 + 登录页可选入口 + 2FA 挑战页加 Passkey 分支）                                                                                                                |
| 关联     | RFC 0002（2FA TOTP — Passkey 与之共存为同级 2FA 因子）· RFC 0004 §1「SSO 用户默认豁免 2FA」· RFC 0005（Region — RP ID 自然 share-nothing）· RFC 0001 §1（这条编号原本占位过 WebAuthn，被 RFC 0006 顺延过来） |

---

## 1. 背景与目标

v0.7 之前 Kitora 的账号体系覆盖了 4 条上行路径：

- **Credentials**（邮箱 + 密码 + 可选 TOTP 二因子，RFC 0002 PR-2）
- **OAuth**（GitHub / Google，Auth.js v5 内建）
- **SSO**（SAML + OIDC + SCIM，RFC 0004）
- **API token**（Bearer，RFC 0001 PR-3 + RFC 0003）

仍然差一条：**WebAuthn / Passkey**。这条本来在 RFC 0002 §1 与 RFC 0004 §1 早期占位时挂在「RFC 0006 处理」，RFC 0005 把 0006 编号挪给 CN 区部署，故顺延到本 RFC。

**为什么 2026 这一年要做**：

- **行业惯性已成**——GitHub、Microsoft、Apple、Google Workspace、Cloudflare、Stripe Dashboard、Atlassian 都已经把 Passkey 作为登录页一等公民。SaaS 模板不接 = 与 Auth.js 默认分支拉开差距。
- **防钓鱼是 Passkey 的杀手锏**——TOTP 仍可被中间人钓走（用户在伪造站点输入 6 位码也会被转手），WebAuthn 走域名绑定的非对称签名，钓鱼站点的源域名不匹配 → 浏览器拒绝出签。这条对面向开发者 / 中型企业的客群是显著卖点。
- **同步 passkey 已普及**——iCloud Keychain / Google Password Manager / Bitwarden / 1Password 都同步 passkey 跨设备，user-multi-device 不再是 UX 痛点。
- **Auth.js v5 与 `@simplewebauthn/server` 接入路径成熟**——RFC 0004 SSO 已经走过「自定义 JWT 直发 cookie」的 bypass 模式（`src/lib/sso/issue-session.ts`），同样的模板复用即可，无需自定义 Auth.js Provider 引入额外复杂度。

**目标**（v1，本 RFC 落地范围）：

- **双轨设计**：Passkey 既作**第二因子**（与 TOTP 同级，在 `/login/2fa` 页可二选一通过挑战），也作**密码快捷登录**（在 `/login` 页一步进 dashboard，无需输入密码）。
- **per-user 多 credential**：同一用户挂笔记本 Touch ID + 手机 Face ID + YubiKey，都视为同一账号下并列 credential。任意一个通过即可登录 / 通过 2FA 挑战。
- **设置页管理**：`/settings/security/passkeys` 列出 / 添加 / 重命名 / 删除，与 RFC 0002 PR-1 的 Active Sessions 同 UX 模板。
- **与现有 session 机制集成**：Passkey 通过后走 `issueSsoSession` 同款 JWT 直发路径——`sid` + `DeviceSession` 行 + `sessionVersion` 同步——middleware 解出来的 session 与 password / OAuth / SSO 路径是同 shape。
- **Region 自然隔离**：RP ID（Relying Party ID）= 部署域名（kitora.io / kitora.cn）；同邮箱在两个 region 各注册的 credential 互相不可见，与 RFC 0005 share-nothing 一致。
- **SSO 用户豁免**：`/login/2fa` 页面上看不到 Passkey tab；如果 IdP 自带 MFA，再叠 Passkey 是徒增摩擦。开关由 RFC 0004 §6 的「`require2fa` org-level toggle」继承。

**非目标**：

- **WebAuthn 替代 SSO**——IdP 走 SAML/OIDC 仍是 enterprise 客户的硬要求，本 RFC 不动那条路径。
- **强制 passkey-only 账号**——「不要密码、只要 passkey」的 user-level 选项留 follow-up。理由：用户丢光所有 credential 时的恢复路径比较复杂，v1 不接。
- **Attestation 验证**——`AttestationConveyancePreference: 'none'`。我们不需要绑定 FIDO certified 厂商。Enterprise 客群如果要求强 attestation 走 SSO + IdP 那一条。
- **CTAP2 hardware-only enforcement**——不限制 credential 必须来自硬件 key。同步 passkey（multi-device）和 device-bound passkey（single-device）都接受，仅在 UI 上区分显示。
- **跨 region 共享 credential**——RP ID 不同 → credential 域名不互通，自然分隔。
- **WebAuthn 替代 backup codes**——RFC 0002 PR-2 的 backup codes 仍保留作为「丢光所有设备」的兜底；passkey 不是恢复机制。

---

## 2. 设计原则

| 原则                            | 解释                                                                                                                                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **库选型保守**                  | `@simplewebauthn/server` + `@simplewebauthn/browser`（v13+），社区维护、TypeScript 全覆盖、与 Auth.js v5 ecosystem 友好。不自实现 CBOR / COSE 解析。                                                                                                       |
| **不引入 Auth.js Provider**     | Passkey 走 `issueSsoSession` 同款 JWT 直发路径（`next-auth/jwt encode` + cookie set）。理由：Auth.js v5 的 Credentials provider 与 WebAuthn flow 阻抗不匹配，自定义 provider 维护成本超过收益。                                                            |
| **多 credential 平等**          | 同一 userId 下任意 credential 通过即视为身份验证成功；不引入「主 credential / 备用 credential」概念。Counter 单独维护。                                                                                                                                    |
| **同步 / 设备绑定区分仅 UI 层** | 数据库存 `deviceType: 'singleDevice' \| 'multiDevice'` 与 `backedUp: boolean`，UI 上展示成「Synced across devices」/「This device only」，不影响验证流程。                                                                                                 |
| **Region 即 RP ID**             | `WEBAUTHN_RP_ID` env 在生产由 `currentRegion()` 决定（kitora.io / kitora.cn / kitora.eu），dev / e2e fallback 到 `localhost`。同邮箱跨 region 注册的 credential **不可互通**，符合 RFC 0005 share-nothing。                                                |
| **挑战短命，非永久状态**        | 每次注册 / 验证生成的 challenge 存 `User.webauthnChallenge` 列（5 分钟 TTL），下一次操作覆盖；不维护独立 challenge 表，避免无谓持久化。                                                                                                                    |
| **同 session shape**            | 通过 Passkey 拿到的 cookie 与 password / OAuth / SSO cookie 中字段（`sub` / `id` / `role` / `sessionVersion` / `status` / `tfa_pending: false` / `sid` / `sidHash`）完全一致 → middleware 看不到差别 → 下游 API / RSC / DeviceSession 列表全部不需要适配。 |
| **降级先于扩展**                | 浏览器不支持 WebAuthn 时（极少；2026 主流浏览器全覆盖），登录页 Passkey 按钮隐藏；2FA 挑战页 fallback 到 TOTP-only。不报错、不阻断。                                                                                                                       |

---

## 3. 数据模型变更

### 3.1 新表 `WebAuthnCredential`

```prisma
model WebAuthnCredential {
  id           String    @id @default(cuid())
  userId       String
  // base64url 编码的 credential id（即 WebAuthn 协议里的 `credentialID`）。
  // 必须 @unique 因为 Allow / Exclude credentials 列表查的是它。
  credentialId String    @unique
  // CBOR / COSE 编码的公钥 bytes。@simplewebauthn 直接吐 Uint8Array，
  // Prisma Bytes 列存原样字节，验签时 .verifyAuthenticationResponse() 直接吃。
  publicKey    Bytes
  // 每次成功验证后 @simplewebauthn 返回新的 counter。我们存最新值，
  // 下次比对：当前 counter > 存储 counter → 接受 + 更新；否则视为 replay → 拒。
  // 同步 passkey（iCloud Keychain）counter 永远是 0，单独跳过比较。
  counter      Int       @default(0)
  // ['usb','ble','nfc','internal','hybrid'] 子集，影响下次 challenge 时
  // browser hint UI（让 PC 用户知道是用电脑指纹还是扫手机）。
  transports   String[]  @db.Text
  // 'singleDevice'（device-bound）或 'multiDevice'（synced passkey）。
  // 仅 UI 展示用。
  deviceType   String
  // browser 上报的「这把 key 是否被云端备份过」。决定 UI 提示文案
  // 「丢了设备能不能找回」。
  backedUp     Boolean
  // 用户给的标签：「我的 MacBook」「YubiKey 5」。注册时默认从 transports
  // 推一个，列表里可改名。
  name         String
  lastUsedAt   DateTime?
  createdAt    DateTime  @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, lastUsedAt])
}
```

迁移：`prisma/migrations/20260601100000_add_webauthn_credential/`，纯加表 + 索引，秒级，零回填。

### 3.2 User 模型加两列（短命 challenge 状态）

```prisma
model User {
  // ... existing
  // RFC 0007 — WebAuthn ephemeral challenge.
  // Set when register / authenticate ceremony starts; cleared on
  // verify (success or fail) or after 5 minutes (lazy: read-time
  // expiry check). NOT a long-lived secret — overwritten on every
  // new ceremony.
  webauthnChallenge   String?
  webauthnChallengeAt DateTime?
}
```

迁移：与 §3.1 同一个 migration 文件夹，纯加列，default null。

### 3.3 不加的列 / 不动的表

- **`User.passkeyOnly`** —— 「禁用密码登录、只接受 passkey」的开关，留 follow-up RFC（`/login` 流程改造比较大）。
- **`TwoFactorSecret`** —— 不动。WebAuthn 不需要扩展现有 TOTP 表，二者通过 `User.id` 各自查询。
- **`AuditLog.action` 枚举** —— 不引入新 enum，复用字符串：`webauthn.credential_added` / `webauthn.credential_renamed` / `webauthn.credential_removed` / `webauthn.login_succeeded` / `webauthn.tfa_succeeded`。

---

## 4. 模块设计

### 4.1 库与依赖

新增两个 npm 依赖：

- `@simplewebauthn/server@^13` —— 服务端 challenge / verify。
- `@simplewebauthn/browser@^13` —— 浏览器端 `startRegistration()` / `startAuthentication()` 包装。

`package.json` 加这两条；`pnpm-lock.yaml` 与 `package.json` 同 commit。

### 4.2 核心 lib（`src/lib/webauthn/`）

新增目录，3 个文件：

- **`config.ts`** —— `getRpId()` / `getRpName()` / `getOrigin()` 读 env，未设时按 region + `NEXT_PUBLIC_APP_URL` 推断。
- **`challenge.ts`** —— `mintChallenge(userId)` 生成 32 字节 base64url + 写 `User.webauthnChallenge` + 设 `webauthnChallengeAt = now()`；`consumeChallenge(userId)` 读 + 校验 5 分钟内 + 清空，返回 challenge 字符串。
- **`verify.ts`** —— 包装 `@simplewebauthn` 的 `verifyRegistrationResponse` / `verifyAuthenticationResponse`，统一 origin / rpId 校验、错误日志、counter 比较。

### 4.3 服务端路由（5 条）

均在 `src/app/api/auth/webauthn/` 下：

- `POST /api/auth/webauthn/register/options` —— 已登录用户，返回 `PublicKeyCredentialCreationOptions`。后端调用 `@simplewebauthn/server` 的 `generateRegistrationOptions`，写 challenge。
- `POST /api/auth/webauthn/register/verify` —— 接收 `RegistrationResponseJSON`，验签 + 写入新 `WebAuthnCredential` 行 + `recordAudit('webauthn.credential_added')`。
- `POST /api/auth/webauthn/authenticate/options` —— 未登录或 2FA-pending 用户，返回 `PublicKeyCredentialRequestOptions`。两种调用上下文：
  - **Discoverable / usernameless**（密码快捷登录）：`allowCredentials: []`，浏览器自己弹 credential picker。
  - **Conditional UI / 2FA**（已知 user）：`allowCredentials: [<本用户所有 credentialId>]`。
- `POST /api/auth/webauthn/authenticate/verify` —— 接收 `AuthenticationResponseJSON`，反查 credentialId → user → verify → 更新 counter / lastUsedAt → 路由分叉：
  - 若调用上下文是「passwordless 登录」：调 `issueSsoSession({ userId, ... })` 直发 cookie，redirect to `/dashboard`。
  - 若调用上下文是「2FA 挑战」：bump session 把 `tfa_pending` 清成 false（实际是发新 cookie 因为 JWT immutable），同款 `issueSsoSession` 即可。
- `DELETE /api/auth/webauthn/credentials/:id` —— 已登录用户删自己的 credential。`recordAudit('webauthn.credential_removed')`。

注：路由不放在 `/api/v1/...` 下，因为不是公开 API（OpenAPI spec 不要 surface）；与 `/api/auth/sso/*` 同级。

### 4.4 客户端组件

- **`<RegisterPasskeyButton />`**（`src/components/auth/register-passkey-button.tsx`）—— 触发 `startRegistration()`；放在 `/settings/security/passkeys` 添加按钮。
- **`<PasskeyList />`** —— 列出当前用户所有 credential，显示 name / deviceType / backedUp / lastUsedAt / 删除按钮。
- **`<SignInWithPasskeyButton />`** —— `/login` 页 secondary action，触发 discoverable `startAuthentication()`。
- **`<TwoFactorPasskeyTab />`** —— `/login/2fa` 页加一个 tab 与现有 TOTP form 并列；展示「Use a passkey」按钮，触发 conditional `startAuthentication()`（`allowCredentials` 限本用户）。

### 4.5 与现有 2FA 状态机的集成

RFC 0002 PR-2 的 jwt callback 在 sign-in 时根据 `user.twoFactorEnabled` 设 `token.tfa_pending = true`。本 RFC 不改这条：

- 用户**只有 TOTP** → tfa_pending = true → /login/2fa 页只显示 TOTP form（Passkey tab 因没 credential 而隐藏）。
- 用户**只有 Passkey** → tfa_pending = true（因为我们扩 `twoFactorEnabled` 的语义为「TOTP OR Passkey 任一」，见 §4.6）→ /login/2fa 页只显示 Passkey tab（TOTP form 因没 secret 而隐藏）。
- 用户**两者都有** → tfa_pending = true → /login/2fa 页两个 tab 都显示，二选一通过即放行。
- 用户**两者都没** → tfa_pending = false → 直接进 dashboard。

### 4.6 `User.twoFactorEnabled` 语义扩展

RFC 0002 PR-2 引入的 `twoFactorEnabled` 是「有没有 TOTP」的去归一化标记。本 RFC 把语义扩成「有没有任何二因子」，触发条件加 OR：

```
twoFactorEnabled = (TOTP 已启用) OR (至少一个 WebAuthnCredential 行)
```

更新点：

- 添加第一个 passkey 时，server action 同事务 set `User.twoFactorEnabled = true`（如未已 true）。
- 删除 passkey 时，如果删完 user 既无 TOTP 也无任何 WebAuthnCredential → `twoFactorEnabled = false`。
- TOTP 启用/禁用同 RFC 0002 PR-2，逻辑不变；启用时用 `OR(WebAuthnCredentials > 0, TRUE)`，禁用时用 `OR(WebAuthnCredentials > 0, FALSE)`。
- 把这两个分支抽到 `src/lib/auth/two-factor-state.ts`，避免散落在多个 server action。

---

## 5. 登录页 / 2FA 页面 UX

### 5.1 `/login`

新加 secondary CTA：「Sign in with a passkey」。

```
┌─────────────────────────────────────────┐
│  Sign in to Kitora                       │
├─────────────────────────────────────────┤
│  Email     [..............................] │
│  Password  [..............................] │
│  [ Sign in ]                                │
│                                              │
│  ─────────  or  ─────────                    │
│                                              │
│  [ 🔐  Sign in with a passkey ]              │
│                                              │
│  [ Continue with GitHub  ] [ Continue with Google ] │
└─────────────────────────────────────────┘
```

Passkey 按钮点击 → `navigator.credentials.get({ mediation: 'optional', publicKey: ... })`（discoverable）→ 浏览器自带 picker → 用户选 credential → 走 `/api/auth/webauthn/authenticate/verify` → cookie set → redirect。

按钮在 `WEBAUTHN_RP_ID` 未配 OR `navigator.credentials` 不可用时**隐藏**（不报错）。

### 5.2 `/login/2fa`

现有页面改为 tabs：

```
┌──────────────────────────────────────────┐
│  Two-factor authentication                │
├──────────────────────────────────────────┤
│  [ 🔐 Passkey ]  [ 📱 Authenticator code ] │
│  ───────────                                 │
│  Use a passkey to confirm it's you:          │
│  [ Use a passkey ]                            │
│                                               │
│  Or use a backup code instead.                │
└──────────────────────────────────────────┘
```

Tab 默认值：用户最后一次成功因子的同款（基于 `recordAudit` 的 last action）。无历史则默认 Passkey（如有 credential）否则 TOTP。

Backup codes 路径不动，沿用 RFC 0002 PR-2 的实现。

### 5.3 `/settings/security/passkeys`

新页面，挂在现有 `/settings` 路由下。结构：

```
┌────────────────────────────────────────────┐
│  Passkeys                                    │
│  ────────                                    │
│  Add and manage passkeys for this account.   │
│                                               │
│  [ + Add a passkey ]                         │
│                                               │
│  • Jane's MacBook (Touch ID)                  │
│    Synced across devices · last used 3h ago   │
│    [ Rename ] [ Remove ]                      │
│                                               │
│  • YubiKey 5                                  │
│    This device only · last used 14d ago       │
│    [ Rename ] [ Remove ]                      │
└────────────────────────────────────────────┘
```

最后一条 credential 移除前提示：「这把是你最后一个 passkey，移除后将不能用 passkey 登录。」（不阻拦，只是 confirm）。

---

## 6. PR 拆分

| PR   | 范围                                                                                                                                                                                                                                   | 估时    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| PR-1 | Schema 迁移 + 库依赖 + `src/lib/webauthn/{config,challenge,verify}.ts` 核心 lib                                                                                                                                                        | 1 天    |
| PR-2 | 注册流：`/api/auth/webauthn/register/{options,verify}` 路由 + `/settings/security/passkeys` 页面（列表 + 添加 + 重命名 + 删除）+ `<PasskeyList />` + `<RegisterPasskeyButton />`+ `User.twoFactorEnabled` 抽象到 `two-factor-state.ts` | 2 天    |
| PR-3 | 2FA 挑战集成：`/login/2fa` 页 tabs 改造 + `<TwoFactorPasskeyTab />` + `/api/auth/webauthn/authenticate/{options,verify}` 在 2FA 上下文路径分支                                                                                         | 1 天    |
| PR-4 | 密码快捷登录：`/login` 页加 `<SignInWithPasskeyButton />` + 同上 verify 路由在 passwordless 上下文路径分支 + Discoverable / usernameless flow + 集成 `issueSsoSession`                                                                 | 1.5 天  |
| PR-5 | i18n（en / zh）+ audit `webauthn.*` action 落地 + e2e（注册一把 / 列表显示 / 删除 / 用 passkey 走 2FA / 用 passkey passwordless 登录 5 个 case）+ docs/rfcs/0007 §13 实施完成回填 + CHANGELOG `[0.8.0]`                                | 1 天    |
| 合计 |                                                                                                                                                                                                                                        | ~6.5 天 |

每个 PR 拒绝大杂烩——一个 commit 不跨 「lib + 路由 + 页面」三层。

### 6.1 回滚

- PR-1 schema migration：纯加表 + 加列，回滚需 drop 表 + drop 列；不影响现有 user 行。
- PR-2 / PR-3 / PR-4：每个都 gate 在 `WEBAUTHN_RP_ID` env 是否存在；env 未设时所有 passkey UI 与路由静默隐藏 / 404。生产回滚 = 拆 env。
- PR-5：纯文档 + e2e + i18n，revert commit 即可。

---

## 7. 风险与对策

| 风险                                                          | 对策                                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用户丢光所有 passkey 设备                                     | TOTP 与 backup codes 路径保留；`/settings/security` 页提示「至少保留一种二因子或一组 backup codes」；删除最后一个 passkey 走 confirm dialog。     |
| Phishing 站点诱导用户「重新注册」passkey                      | RP ID 域名绑定本质上防止跨域注册——浏览器看到 origin 不匹配会拒签；我们只需保证 `WEBAUTHN_RP_ID` 严格等于生产域名，dev / staging 各自独立。        |
| Counter 不支持同步 passkey（永远是 0）                        | `verify.ts` 对 counter == 0 的 credential 跳过 replay 比较（与 `@simplewebauthn` 默认行为一致，仅 log warn）；device-bound passkey 仍走严格比对。 |
| 浏览器版本太老（Safari < 16，Chrome < 92）不支持 WebAuthn     | 客户端能力探测：`window.PublicKeyCredential` 不存在 → 隐藏所有 passkey UI；2FA 挑战页 fallback 到 TOTP-only（已是默认 form）。                    |
| 同 region 不同 stack（prod / staging）共用一个 RP ID 容易混淆 | 各环境配独立 `WEBAUTHN_RP_ID`：prod 用 `kitora.io`、staging 用 `staging.kitora.io`。dev 默认 `localhost`。                                        |
| 用户改名 / 改邮箱后旧 credential 是否仍可用                   | 仍可用——credential 绑的是 `userId`，与 email / name 解耦。改邮箱后下次 passkey 登录能直接进。                                                     |
| Cross-region cookie smuggling 走 passkey 路径绕过 RFC 0005    | RP ID 自然按域名分区——`kitora.cn` 上注册的 passkey 不可能在 `kitora.io` 上验签通过。Region drift guard 仍在 middleware 层兜底。                   |
| Auth.js v5 升级时 `next-auth/jwt encode` 接口变更             | 已经在 RFC 0004 SSO 用过同款 encode；本 RFC 走相同抽象（`issueSsoSession`），跟进 Auth.js v5 升级时一处修复即可。                                 |
| 多 credential 同时通过同一 challenge                          | 不可能——`@simplewebauthn` 的 challenge 是 nonce，浏览器一次只能签一把；存储侧用 `User.webauthnChallenge` 单值，下一次操作覆盖。                   |
| 删除 credential 引发 `twoFactorEnabled` 翻 false 时 race      | 删除 server action 用事务，先 delete + count 剩余 → 0 时同事务 update `twoFactorEnabled = false`。RFC 0002 PR-2 同样的事务模板。                  |

---

## 8. 工作量与时间表

```
Day 1     ┃ PR-1：schema + 库 + lib
Day 2-3   ┃ PR-2：注册流 + settings 页
Day 4     ┃ PR-3：2FA tab 集成
Day 5-6   ┃ PR-4：passwordless 登录
Day 7     ┃ PR-5：i18n + e2e + RFC 收尾
```

合计：**~7 工程日**（无外部资质依赖，无监管流程）。

---

## 9. 待评审决策（Draft 阶段）

下列项在 PR-1 起手前需拍板。

- [ ] **库版本 pin** —— `@simplewebauthn/server` v13 vs v14（2026 时点活跃）。建议 **v13.x**：v14 在 Authenticator extensions 上有 breaking change，社区还没完全迁移完毕；v13 已 stable 半年，文档更全。
- [ ] **default RP Name** —— UI 里 OS / Browser 弹出的「Sign in to \_\_\_」。建议 **`Kitora`**（与 `EMAIL_FROM` fromAlias 一致）；按 region 下沉 `Kitora 中国` 这种细粒度先不做。
- [ ] **discoverable login 的 `userVerification`** —— `'preferred'` 还是 `'required'`。建议 **`'preferred'`**：required 对 YubiKey 这种纯硬件 key 不友好（无 UV 的 key 直接出错），preferred 既允许 UV 优先又兼容老 key。
- [ ] **Conditional UI 自动激活** —— 浏览器原生支持 conditional UI 时（Safari 16+、Chrome 108+），登录表单 email 输入框 autocomplete attribute 加 `username webauthn` 就能让浏览器在用户聚焦时自动弹 passkey picker。建议 **v1 不开**，原因：autocomplete 机制不稳定，老 OS / 部分企业策略下表现奇怪；v1 用显式按钮更可控。
- [ ] **新增 credential 后强制重新登录** —— 添加 passkey 是否 bump `sessionVersion` 失效其他设备？建议 **不 bump**：注册新 credential 是「加」操作而非「换」操作，没必要踢用户。删除 credential **同样不 bump**，但 admin 主动「全设备登出」（已有 RFC 0002 PR-1 入口）路径不变。
- [ ] **Backup codes 是否仍当 passkey 的恢复路径** —— v1 行为：既能解 TOTP 也能跳过 passkey 挑战。建议 **保留这个语义**——backup codes 是「丢光所有二因子」的最后兜底，passkey 不过是其中一类二因子。
- [ ] **是否 surface 到公开 OpenAPI** —— `/api/auth/webauthn/*` 是否写进 `openapi/v1.yaml`。建议 **不写**：第一方登录页与 settings 页消费，OpenAPI 是给 enterprise 集成的，第三方拿 passkey 路径意义不大。
- [ ] **同步 passkey UI 提示文案** —— `backedUp = true` 的 credential 是否在删除按钮旁加「此 passkey 已在 iCloud Keychain / Google Password Manager 备份，可在另一台设备恢复。」提示？建议 **加**——降低用户「删了就丢」的焦虑。

---

## 10. 与历史 RFC 的衔接

- **RFC 0001（Organizations）**：不动。passkey 是 user-level 凭证，不挂 org。
- **RFC 0002（2FA TOTP / Active Sessions / 数据导出）**：本 RFC 扩 `User.twoFactorEnabled` 语义（OR Passkey 存在性）；TOTP / backup codes 路径不动；DeviceSession 通过 `issueSsoSession` 同款继续创建。
- **RFC 0003（出站 webhook / OpenAPI）**：不 surface 到公开 API；audit 事件 `webauthn.*` 通过既有 `from-audit.ts` 出站 webhook 自动 promotion 为 `audit.recorded`，需要的客户能订阅到。
- **RFC 0004（SSO）**：SSO 用户登录路径中**不出现** Passkey UI。`enforceForLogin = true` 的 org 成员只能走 IdP；在 `/settings/security/passkeys` 页面也提示「您的组织已启用 SSO 强制登录，passkey 将仅作为 fallback 保留但不能用于本系统主登录」。
- **RFC 0005（Multi-region）**：RP ID 自动按域名分区；`WEBAUTHN_RP_ID` env 由 region 决定（生产用部署域名，dev / e2e 用 `localhost`）。`recordAudit` 已自动 stamp region。
- **RFC 0006（CN 区落地）**：CN region 走 `kitora.cn` 作为 RP ID，credential 永不离开境内（passkey 公钥本身不是「个人信息」，但 audit log 里关联的 user/region 受 PIPL 保护——已经合规）。

---

## 11. 实施完成（v0.8.0 工程交付）

> 全部 5 个 PR 已合入主干并随 v0.8.0 发版。Passkey 双轨能力（2FA 因子 + 密码快捷登录）在 production 默认 **关闭**，需要把 `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` 两个 env 同时显式配置才会激活；保留 env-gate 是 §6.1 写死的回滚开关。

工程交付清单（按 PR 排）：

- **PR-1**（schema + 库依赖 + 核心 lib）—— `prisma/migrations/20260601100000_add_webauthn_credential/`、`prisma/schema.prisma`（`WebAuthnCredential` 表 + `User.webauthnChallenge` / `User.webauthnChallengeAt` 双列）、`src/lib/webauthn/{config,challenge,verify}.ts`、`src/env.ts`（3 个 env：`WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ORIGIN`）、`@simplewebauthn/server@^13.3.0` + `@simplewebauthn/browser@^13.3.0` 两个依赖。
- **PR-2**（注册流 + settings 页 + two-factor-state 抽象）—— `src/app/api/auth/webauthn/register/{options,verify}/route.ts`、`src/app/api/auth/webauthn/credentials/[id]/route.ts`（PATCH/DELETE）、`src/app/[locale]/(dashboard)/settings/security/passkeys/page.tsx`、`src/components/account/{passkey-list,register-passkey-button}.tsx`、`src/lib/auth/two-factor-state.ts`（OR(TOTP, Passkey) 推导）、`src/lib/audit.ts`（5 个 `webauthn.*` action 落地）。
- **PR-3**（2FA 挑战集成）—— `src/lib/account/passkeys.ts`（server actions：`getPasskeyChallengeAction` / `verifyPasskeyForCurrentSessionAction`）、`src/components/auth/{two-factor-passkey-form,two-factor-challenge-tabs}.tsx`、`src/app/[locale]/(auth)/login/2fa/page.tsx`（按 `(twoFactorSecret.enabledAt, count(WebAuthnCredential))` 决定 tab 渲染）。
- **PR-4**（passwordless 登录入口）—— `src/lib/webauthn/anonymous-challenge.ts`（httpOnly cookie，5 min TTL，path 限定到 `/api/auth/webauthn/authenticate`）、`src/app/api/auth/webauthn/authenticate/{options,verify}/route.ts`（IP 限流、统一 401 generic 错误码以避免 credentialId 探测）、`src/components/auth/sign-in-with-passkey-button.tsx`（`browserSupportsWebAuthn()` 自门控 + `window.location.assign(redirectTo)` 硬跳转）、`src/app/[locale]/(auth)/login/page.tsx`（接 `?callbackUrl=` 透传）。
- **PR-5**（i18n + e2e + RFC / CHANGELOG 收尾）—— `messages/{en,zh}.json` 中 `account.passkeys.*`、`auth.twoFactorChallenge.{tabs,passkey}.*`、`auth.login.passkey.*` 三组 key；`tests/e2e/webauthn-passkey.spec.ts`（Playwright + CDP `WebAuthn` 虚拟 authenticator，覆盖 register / list / remove / passwordless 4 个 case，2FA tab 的 case 借用同一个 CDP 通路）；本节回填；`CHANGELOG.md` `[0.8.0]` 段；`package.json` 0.7.0 → 0.8.0。
- **未交付**（RFC §6 / §9 已声明的非目标 / v1 不做）：
  - Conditional UI 自动激活（`autocomplete="username webauthn"` 在 email 输入框）—— §9 决策为 v1 不开。
  - Authenticator extensions（`largeBlob` / `prf` / `credBlob`）—— v1 全不开，挂在 future RFC。
  - 公开 `/api/auth/webauthn/*` 到 `openapi/v1.yaml` —— §9 决策为不写，第三方拿不到 passkey 路径意义不大。
  - Passkey 相关 admin 后台视图（管理员代查 / 强制删除）—— follow-up RFC。
- **决策回填**（§9 待评审项）：
  - ✅ `@simplewebauthn` 锁 v13.x（PR-1 `package.json` 中 `^13.3.0`）。
  - ✅ Default RP Name = `Kitora`（PR-1 `getRpName()` env fallback）。
  - ✅ `userVerification: 'preferred'` 同时用于注册与认证（PR-2 / PR-3 / PR-4 三处 generate options 默认值）。
  - ✅ Conditional UI **不开**（PR-4 显式按钮）。
  - ✅ 注册 / 删除 credential **不 bump** `sessionVersion`（PR-2 路由不调 `bumpSessionVersion`）。
  - ✅ Backup codes 仍可作为 passkey 的兜底恢复路径（RFC 0002 PR-2 路径未动）。
  - ✅ 公开 OpenAPI **不收录** `/api/auth/webauthn/*`（PR-2 / PR-3 / PR-4 均未触 `openapi/v1.yaml`）。
  - ✅ Synced passkey 行展示「Cloud-backed up」提示（PR-2 `passkey-list.tsx` 的 `t('backedUp')`）。
- **首日观测指标**（生产开启 `WEBAUTHN_RP_ID` 后回填）：注册成功率（`webauthn.credential_added` / 总注册尝试）、2FA 挑战成功率（`webauthn.tfa_succeeded` vs TOTP 同期对比）、passwordless 登录成功率（`webauthn.login_succeeded` / `/login` PV）、浏览器 + OS 分布（来自 audit metadata 的 user-agent header）、credential `deviceType` 分布（`singleDevice` vs `multiDevice` 比例，反映用户在硬件 key vs iCloud / Google 同步 passkey 之间的偏好）。
