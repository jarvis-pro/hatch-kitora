# RFC 0001 — 多租户 / 团队协作（Organizations）

| 状态     | Approved（2026-04-26）                |
| -------- | ------------------------------------- |
| 作者     | Jarvis                                |
| 创建于   | 2026-04-26                            |
| 影响版本 | 0.x → 0.y（破坏性，需迁移）           |
| 关联     | README 路线图 · Phase「multi-tenant」 |

---

## 1. 背景与目标

Kitora 当前所有资源（`Subscription` / `ApiToken` / `AuditLog`）都挂在 `User` 上，是单人 SaaS。要面向 B2B / 团队场景，必须引入「组织」概念，让账号、计费、API 凭证、审计在 org 维度共享。

**目标**：

- 引入 `Organization` 作为资源归属主体；用户通过 `Membership` 加入组织，承担 org 内角色。
- 现有 user 维度的资源（订阅、token、审计）平滑迁到 org 维度，无需停服。
- Stripe 计费按 org（而不是 user）开 customer，支持 per-seat 计费。
- 公开 API 切到 `/api/v1/orgs/{slug}/...` 路径模型。
- 不破坏现有单用户使用方式：注册自动创建一个 Personal Org，体验保持原样。

**非目标**：

- 跨 org 的资源共享 / 嵌套组织 / 组织树。
- SSO（SAML / SCIM 留给后续 RFC）。
- 邀请之外的成员发现机制（域名自动加入等）。

---

## 2. 核心设计

### 2.1 Personal Org 模型（不分轨）

每个用户注册时自动创建一个名为 `Personal` 的组织，`slug = personal-{shortId}`，用户为 `OWNER`。所有资源（订阅、token、审计）一律挂 org，**没有 user-only 资源**。这样：

- 升级路径只有一条，避免「user-level vs org-level」双轨地狱。
- 用户单飞时和现在体验一致——dashboard 默认进 personal org。
- 想拉人进来时直接邀请即可，不需要「迁移到组织」流程。

替代方案（user-level personal + org-level，已否决）：维护两套权限和两套 Stripe customer，复杂度极高且无明显收益。

### 2.2 角色

Org 内三档：

| 角色   | 权限                                                               |
| ------ | ------------------------------------------------------------------ |
| OWNER  | 全部权限；可转让所有权；可删除 org；唯一计费签约人                 |
| ADMIN  | 管理成员（邀请 / 移除 / 改角色，但不能动 OWNER）；管账单；管 token |
| MEMBER | 只读 org 资源；可生成自己名下的 org-scoped API token               |

每个 org 必须有且仅有一个 OWNER。OWNER 转让是显式动作，走二次确认。

平台级 `User.role`（`USER` / `ADMIN`）保留，意义不变——它是平台运维角色，与 org 内角色完全解耦。

### 2.3 数据模型变更

新增三张表：

```prisma
model Organization {
  id               String   @id @default(cuid())
  slug             String   @unique           // URL-safe, lowercase, e.g. "acme"
  name             String
  image            String?
  // Stripe customer 从 User 迁到 Org
  stripeCustomerId String?  @unique
  // 占位字段：per-org ICP 备案号；业务逻辑见 RFC 0005，PR-1 仅加列不读写
  icpNumber        String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  memberships   Membership[]
  invitations   Invitation[]
  subscriptions Subscription[]
  apiTokens     ApiToken[]
  auditLogs     AuditLog[]

  @@index([slug])
}

model Membership {
  id             String        @id @default(cuid())
  orgId          String
  userId         String
  role           OrgRole       @default(MEMBER)
  joinedAt       DateTime      @default(now())

  organization Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  user         User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([orgId, userId])
  @@index([userId])
}

enum OrgRole {
  OWNER
  ADMIN
  MEMBER
}

model Invitation {
  id         String   @id @default(cuid())
  orgId      String
  email      String
  role       OrgRole
  tokenHash  String   @unique           // sha256(rawToken)
  expiresAt  DateTime
  invitedBy  String                     // userId, no FK so 邀请人删号也能 audit
  acceptedAt DateTime?
  revokedAt  DateTime?
  createdAt  DateTime @default(now())

  organization Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)

  @@unique([orgId, email])              // 同一 org 同邮箱只允许一个 pending 邀请
  @@index([email])
  @@index([expiresAt])
}
```

现有表的字段调整（详见 §3 迁移计划）：

| 表             | 变更                                                           |
| -------------- | -------------------------------------------------------------- |
| `User`         | 删除 `stripeCustomerId`（迁到 Organization）                   |
| `Subscription` | `userId` → `orgId`（保持 NOT NULL；过渡期双写）                |
| `ApiToken`     | 加 `orgId`（NOT NULL）；保留 `userId` 表示 token 的「所属人」  |
| `AuditLog`     | 加 `orgId`（NULLABLE，全局动作如平台 admin 改角色仍可挂 null） |

`ApiToken` 双键的语义：`userId` 是「谁创建的」，`orgId` 是「在哪个 org 用」。Bearer 鉴权时只看 `orgId` 来定 scope，user 信息只用来记录归属。

### 2.4 Active Org 切换

引入 cookie `kitora_active_org`（slug），由 middleware 注入到 request context。所有 server action 与 RSC 通过 `requireActiveOrg()` 拿到当前 org。

URL 模型用 query 还是 path？

- 选 A：`/[locale]/orgs/[slug]/dashboard`（路径携带）
- 选 B：`/[locale]/dashboard` + cookie 决定（路径不变）

**采用 B**。理由：

- 现有 dashboard 路由不动，迁移成本最低。
- Personal Org 单用户时不会被 slug 污染体验。
- Org switcher 改 cookie + `router.refresh()` 即可，不需要全栈跳转。
- 副作用：org-scoped 资源不能直接通过 URL 分享；可接受，分享走 invitation。

当用户切换 org，所有 server-side 数据按新 cookie 读，client 端通过 `Provider` 把 active org 传到上下文。

### 2.5 公开 API 路径

新增 `/api/v1/orgs/[slug]/...` 资源命名空间。Bearer token 自带 orgId，访问其它 org 直接 403。`/api/v1/me` 保持 user-scoped，但响应里加 `organizations[]` 列表（含每个 org 的 role / activeSubscription 摘要）。

### 2.6 Stripe 改造

- `Stripe.customer` 从 user 迁到 org：迁移期内为每个 org 在 Stripe 上**复用现有 customerId**（直接搬过来），避免重新建 customer 引起的对账错乱。
- 计费模型：
  - 当前：单 user 单订阅。
  - 目标：单 org 单订阅，订阅 quantity = active member count（per-seat）。
  - 成员变更（加入 / 移除 / 角色变更不算）触发 `stripe.subscriptions.update({ proration_behavior: 'create_prorations' })`。
- Webhook：保持事件去重不变；用 `customer` 反查 `Organization` 而不是 `User`。

### 2.7 邀请流程

1. ADMIN/OWNER 在 org `members` 页输入 email + role，POST `/api/orgs/{slug}/invitations`。
2. 服务端生成 raw token（base64url，32 字节），落库存 `sha256(token)`，发邮件 `https://app.kitora.com/invite/{rawToken}`。
3. 收件人点链接 → 未登录跳登录 / 注册（邮箱预填且锁定）→ 登录后落到 `/invite/accept` 页。
4. 接受邀请 → 创建 Membership → 标记 `acceptedAt` → 跳到 org dashboard。
5. 邀请 7 天过期；ADMIN 可在 members 页撤销 / 重发。

边界处理：

- 同一邮箱多个 org 的 pending 邀请：允许（不同 orgId）。
- 接受邀请时邮箱必须与登录账号匹配，否则提示「请用 X 邮箱登录」。
- 邀请未注册用户：邮件链接走「注册并接受」一体化流程，签收后默认 emailVerified（因为持有该邮箱的 token）。

---

## 3. 迁移计划（拆 4 个 PR，每个独立可回滚）

### PR-1 引入新表，不改老逻辑

- 加 `Organization` / `Membership` / `Invitation` / `OrgRole`
- `Subscription` / `ApiToken` / `AuditLog` 加 nullable `orgId`
- `Organization.stripeCustomerId` 加列，但 user 上的同名列暂时**保留**（双写过渡）
- 写一个 idempotent 数据回填脚本 `scripts/migrate-personal-orgs.ts`：
  - 对每个 user 创建一个 Personal Org（如果还没有）
  - 把 `User.stripeCustomerId` 复制到 Org
  - 给所有现有 Subscription / ApiToken / AuditLog 填上对应的 orgId

通过点：脚本可重复跑；prod 上手动跑一次后所有现有数据完成关联。

### PR-2 切代码读写到 orgId（双写期）

- `lib/auth/session` 增 `requireActiveOrg()`，从 cookie 解析 active slug
- 所有 server action / RSC 改用 orgId 查 Subscription / ApiToken
- Stripe webhook 改用 `customer` → Organization 反查
- API token bearer 鉴权挂 orgId
- 旧 `userId` 字段同步写一份（向后兼容回滚）
- e2e 全跑过

### PR-3 UI 落地

- Sidebar Org Switcher（含 Personal Org，按字母排序）
- `/settings` 拆 Personal / Organization 两个 tab
- 新增 `/settings/members`（成员列表 / 邀请 / 改角色 / 移除）
- 新增 `/settings/organization`（rename / slug / image / transfer ownership / delete）
- 新增 `/invite/[token]` 接受邀请页
- i18n：`messages/{en,zh}.json` 加 `org.*` 一组键
- e2e：邀请 → 接受 → 切换 org → 计费

### PR-4 收尾，去掉旧字段

- 数据校验：`Subscription.orgId` 全部非空 → 改 NOT NULL
- 删 `User.stripeCustomerId` / `Subscription.userId`（保留 `ApiToken.userId` 作为归属人）
- 删双写代码

回滚策略：每个 PR 只做加法或非破坏性改造，前 3 个 PR 任意点都能回退到 main。PR-4 是唯一不可逆的破坏性变更，先在 staging 跑两周再上 prod。

---

## 4. 权限矩阵

抽出 `src/lib/auth/permissions.ts`，提供 `can(user, action, org)`。

| Action                      | OWNER | ADMIN | MEMBER |
| --------------------------- | :---: | :---: | :----: |
| 查看 org 资源               |   ✓   |   ✓   |   ✓    |
| 创建自己的 org-scoped token |   ✓   |   ✓   |   ✓    |
| 撤销别人的 org token        |   ✓   |   ✓   |        |
| 邀请 / 移除成员             |   ✓   |   ✓   |        |
| 改成员角色（不含 OWNER）    |   ✓   |   ✓   |        |
| 改 OWNER / 转让 OWNER       |   ✓   |       |        |
| 管理订阅 / 切计划           |   ✓   |   ✓   |        |
| 改 org 名 / slug / 头像     |   ✓   |   ✓   |        |
| 删除 org                    |   ✓   |       |        |

平台 `User.role = ADMIN` 在所有 org 都拥有 OWNER 等价权限（救火 / 客服）；这类操作必须写 audit log（actor + targetOrgId）。

---

## 5. 公开 API 契约（v1）

新增端点（全部要求 Bearer token，且 token 的 orgId 必须等于路径 `{slug}` 对应 org）：

```
GET    /api/v1/orgs/{slug}                  → org 基本信息 + 当前 user 角色
GET    /api/v1/orgs/{slug}/members          → 成员列表（含 role / joinedAt）
POST   /api/v1/orgs/{slug}/invitations      → 创建邀请
GET    /api/v1/orgs/{slug}/invitations      → pending 列表
DELETE /api/v1/orgs/{slug}/invitations/{id} → 撤销邀请
GET    /api/v1/orgs/{slug}/subscription     → 当前订阅摘要
```

`GET /api/v1/me` 响应新增字段：

```jsonc
{
  "id": "...",
  "email": "...",
  "organizations": [
    {
      "slug": "acme",
      "name": "Acme",
      "role": "OWNER",
      "plan": { "id": "pro", "status": "active" },
    },
  ],
}
```

限流：org 维度 + token 维度都计；先达哪个先 429。

---

## 6. 可观测性 / Metrics

`/api/metrics` 新增：

```
kitora_organizations_total
kitora_memberships_total{role}
kitora_invitations_pending_total
kitora_subscriptions_active{plan}      # 现有 metric 加 org 维度后保持总量不变
```

审计事件新增 `action`：`org.created` / `org.updated` / `org.deleted` / `member.invited` / `member.joined` / `member.removed` / `member.role_changed` / `ownership.transferred`。

---

## 7. 风险与对策

| 风险                                            | 对策                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| 数据回填中途失败导致部分 user 没有 personal org | 脚本幂等可重跑；上线前后跑一次 sanity SQL 确保 every user 至少 1 membership |
| 双写期 orgId / userId 不一致                    | 在 PR-2 加 prisma middleware：写 Subscription 时强制 orgId 必填，否则抛     |
| Stripe customer 迁移导致重复扣费 / 退款风险     | 不重建 customer，仅迁移所属；webhook 反查口径改一行；上 staging 跑全套测试  |
| 邀请 token 邮件被代理预渲染触发误接受           | 用 GET 展示页 + POST 接受动作（POST 才落库），CSRF token 必须               |
| 平台 ADMIN「救火」越权未留痕                    | 强制 audit log，actor + targetOrgId 必填；admin 后台高亮显示                |
| 中国区 ICP 备案主体身份是个人 vs 企业           | 暂不动；后续 RFC（中国区企业资质）单独处理                                  |

---

## 8. 工作量估算

| PR   | 内容                           | 估时    |
| ---- | ------------------------------ | ------- |
| PR-1 | schema 加表 + 回填脚本         | 1 天    |
| PR-2 | 业务逻辑切 orgId（含 webhook） | 2 天    |
| PR-3 | UI / 邀请流 / i18n / e2e       | 3 天    |
| PR-4 | 去旧字段 + 清理                | 0.5 天  |
| 合计 |                                | ~6.5 天 |

---

## 9. 评审决策（2026-04-26 已定稿）

- [x] **Personal Org slug** — 用 `personal-{shortId}`。理由：username 可改 / 可冲突 / 删号链接失效；前缀清晰指示 personal org，单飞用户感知不到。
- [x] **OrgRole `BILLING` 档** — v1 不加。理由：enum 加值不破坏 schema，等真有 SMB / Enterprise 客户提需求再加；现在加只增加测试矩阵。
- [x] **跨 org Token** — 不允许，一 token 绑一 org。理由：scope 清晰、bearer 鉴权代码简单、token 泄漏爆炸半径可控；用户跨 org 各发一个即可。
- [x] **URL 模型** — 纯 cookie B 方案，不预留 path-based。理由：现有路由零改动；未来 SEO 公开主页可单独走 `/[locale]/o/[slug]`，不必整站化。
- [x] **ICP 备案挂 Org** — 现在不实现，仅在 `Organization` 上**保留** `icpNumber String?` 占位字段，业务逻辑推到 RFC 0005「中国区企业资质」。理由：per-org 备案配套需要 KYB / 主体认证 / 审核流转，单独做更稳。

---

## 10. 后续 RFC 占位

- RFC 0002 — 2FA / Active Sessions / 数据导出（安全合规进阶）
- RFC 0003 — 出站 Webhook & OpenAPI 文档站（开发者生态）
- RFC 0004 — SSO（SAML / OIDC / SCIM）
- RFC 0005 — 中国区企业资质 / 多 ICP 备案
