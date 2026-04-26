# RFC 0003 — 出站 Webhook & OpenAPI 文档站（开发者生态）

| 状态     | **Draft**（2026-04-26）                                          |
| -------- | ---------------------------------------------------------------- |
| 作者     | Jarvis                                                           |
| 创建于   | 2026-04-26                                                       |
| 影响版本 | 0.3.0 → 0.4.0（非破坏性，新增表 + 新增公开端点）                 |
| 关联     | RFC 0001 §10 占位 · RFC 0002 §11 占位 · README 路线图「dev-eco」 |

---

## 1. 背景与目标

`/api/v1/me` 已经验证了 Bearer token 鉴权 + 限流的端到端链路，但要让外部集成商真正吃到这个 API，还差两块：

1. **出站 webhook**：让 org 订阅事件（订阅变更、成员变更、审计事件等），我们主动 POST 到他们的 endpoint。pull 模式只对集成商方便；但产品里的实时反应（"用户付款 → 我们的 CRM 立刻发欢迎邮件"）必须靠 webhook。
2. **OpenAPI 文档站**：靠 README 一句 curl 维持开发体验已到天花板。需要一份机器可读的 spec + 浏览器可交互的渲染页 + 类型定义工件。

这两块组合在一起就是 SaaS 模板的「开发者生态」基线——**出站事件 + 自助文档**。再往上的 SDK / Postman collection 留给 RFC 0008+。

**目标**：

- **Webhook**：per-org `WebhookEndpoint` + `WebhookDelivery` 表；HMAC-SHA256 签名 + 时间戳 + 5 分钟 replay 窗口；指数退避重试上限 24h；OWNER/ADMIN 在 `/settings/organization/webhooks` 管理。
- **事件**：v1 覆盖 7 个 — `subscription.created/updated/canceled` · `member.added/removed/role_changed` · `audit.recorded`（订阅审计的标准化兜底）。
- **OpenAPI**：手写 `openapi/v1.yaml`（不引入 Zod-to-OpenAPI 工具）；`/docs/api` 用 [Scalar](https://scalar.com) 渲染（轻量、SSR 友好、单组件）。
- **公开 API 增量**：`/api/v1/orgs/{slug}/webhooks` CRUD、`/api/v1/orgs/{slug}/webhooks/{id}/deliveries`、`/api/v1/events`（dry-run 触发，仅 admin / staging 用）。
- 不破坏现有 `/api/v1/me` 行为，OpenAPI 只是把它**写进契约**。

**非目标**：

- **入站 webhook（Stripe / Resend 等）**已经在 `src/app/api/stripe/webhook` 处理，本 RFC 只做出站。
- **GraphQL** — REST + OpenAPI 已能覆盖 99% B2B 集成需求。
- **SDK 自动生成**（`openapi-typescript` / `kiota`）—— spec 落地后用户可自己跑，模板不内置。
- **Webhook portal 镜像**（Svix / Hookdeck 等托管方案的可视化日志、payload diff）—— v1 仅给 deliveries 列表 + 重试按钮。
- **fan-out 给个人 user webhook** —— webhook 只挂 org，user 不订阅。

---

## 2. Webhook 核心设计

### 2.1 数据模型

两张表 + 一个 status enum。Endpoint 是 OWNER/ADMIN 维护的"我希望 Kitora 把事件发到这个 URL"；Delivery 是每次实际尝试的快照（不可变 + retries）。

```prisma
model WebhookEndpoint {
  id          String   @id @default(cuid())
  orgId       String
  url         String                          // https://example.com/kitora-hooks
  description String?                         // 用户可读标签
  // 用户可勾选要订阅的事件名（白名单）；空数组 = 暂停接收。
  enabledEvents String[]    @db.Text
  // 签名密钥的 sha256；明文仅在创建 / 重生时返回一次。验签时拿明文重算 HMAC。
  secretHash  String                          // sha256(rawSecret)
  // base64url 8 字节，便于在请求头里识别 endpoint 而不暴露 hash。
  secretPrefix String
  // 软暂停 / 硬暂停。
  disabledAt  DateTime?
  // 连续失败累计；达到阈值（见 §2.4）触发自动暂停。
  consecutiveFailures Int   @default(0)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  organization Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  deliveries  WebhookDelivery[]

  @@index([orgId])
  @@index([disabledAt])
}

model WebhookDelivery {
  id            String                @id @default(cuid())
  endpointId    String
  // event 的逻辑 id（cuid），跨 retry 不变；header `X-Kitora-Event-Id` 透出，
  // 接收端可拿来去重。
  eventId       String
  eventType     String
  // 完整 payload 在 DB 里冗余存——用户重试 / 排错时不用回查事件源。
  payload       Json
  status        WebhookDeliveryStatus @default(PENDING)
  // 第几次尝试（1 起）；`MAX_ATTEMPTS = 8` 超过即 DEAD_LETTER。
  attempt       Int                   @default(0)
  // 下一次重试时间；cron 拉 `nextAttemptAt < now() AND status = RETRYING` 行。
  nextAttemptAt DateTime?
  responseStatus Int?
  responseBody   String?              @db.Text
  errorMessage  String?
  createdAt     DateTime              @default(now())
  completedAt   DateTime?

  endpoint WebhookEndpoint @relation(fields: [endpointId], references: [id], onDelete: Cascade)

  @@index([endpointId, createdAt])
  @@index([status, nextAttemptAt])
  @@index([eventId])
}

enum WebhookDeliveryStatus {
  PENDING        // 刚入队，未投递
  RETRYING       // 至少失败过一次，等下一次重试
  DELIVERED      // 2xx 成功
  DEAD_LETTER    // 超过 MAX_ATTEMPTS / 4xx (除 408/429)
  CANCELED       // endpoint 被删除时一并 cancel
}
```

### 2.2 投递流水线

复用 RFC 0002 PR-3 已经验证过的 cron-claim 模式（`scripts/run-export-jobs.ts`）—— 不引入 Inngest / QStash / BullMQ。每分钟跑：

```ts
// scripts/run-webhook-cron.ts
async function main() {
  await recoverStuckDeliveries(); // RUNNING > 5min → RETRYING
  await deliverDueRetries(BATCH); // 拉 RETRYING + nextAttemptAt < now，limit 50
  await cancelOrphans(); // endpoint 删了 / disabledAt 置位 → CANCELED
}
```

为什么继续走 cron 而不上托管 queue：

- 复用已有运维 surface（Vercel Cron / Fly cron），零新组件。
- v1 容量目标：≤ 100 endpoints / org × ≤ 100 events / day = 10000 deliveries / 天，1 分钟 50 deliveries/批（`BATCH=50`）足够。
- 真到容量瓶颈，把 `BATCH` 调大或上 [QStash](https://upstash.com/qstash) 是 follow-up RFC 的事。

#### 入队路径

任何业务代码（Stripe webhook handler / membership action / audit recorder）调 `enqueueWebhook(orgId, eventType, payload)`：

```ts
// src/lib/webhooks/enqueue.ts
export async function enqueueWebhook(orgId: string, eventType: WebhookEventType, payload: object) {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: {
      orgId,
      disabledAt: null,
      enabledEvents: { has: eventType },
    },
    select: { id: true },
  });
  if (endpoints.length === 0) return;

  const eventId = createId();
  const event = { id: eventId, type: eventType, createdAt: new Date(), data: payload };

  await prisma.webhookDelivery.createMany({
    data: endpoints.map((e) => ({
      endpointId: e.id,
      eventId,
      eventType,
      payload: event,
      status: 'PENDING',
      nextAttemptAt: new Date(), // 立即可投
    })),
  });
}
```

事件**不持久化**（不像 Stripe 那样有 `Event` 主表）—— 一个事件 = N 个 delivery 行。重试是行级别的，不是事件级别的。这样 schema 简单，行数膨胀但都是过期可清的（见 §2.5 sweep）。

### 2.3 签名 + replay protection

每条 POST 请求带三个头：

```
X-Kitora-Event-Id:  cmrz...                  # 同一 eventId 跨 retry 不变，方便去重
X-Kitora-Event-Type: subscription.updated
X-Kitora-Timestamp: 1745723404                # epoch 秒
X-Kitora-Signature: t=1745723404,v1=hex(...)  # 仿 Stripe 的 schemed signature
```

签名计算（与 Stripe / GitHub 一致的"timestamp + body" HMAC 模式）：

```
signedPayload = timestamp + "." + rawJsonBody
signature     = hex( HMAC_SHA256(secret, signedPayload) )
header        = "t=" + timestamp + ",v1=" + signature
```

接收端必须做的两件事：

1. **签名校验**：用 endpoint 创建时拿到的明文 secret 重算 HMAC，constant-time compare。
2. **时间戳窗口**：`abs(now - timestamp) ≤ 300s`，否则视为 replay 攻击拒收。

我们提供示例代码（Node.js / Python / PHP）放在 `/docs/api`。

#### 为什么不用 mTLS / JWT

mTLS 让小客户接入门槛飙升（要管 cert）。JWT 看起来"现代"但对方还得验签，代价不比 HMAC 低，而且可读性差（base64 一坨）。HMAC + ts + replay 是 Stripe / GitHub / Slack 都在用的范式，集成商的 mental model 已经成熟。

### 2.4 重试策略

```
attempt | delay
--------|--------
   1    | 0       (立即)
   2    | 30s
   3    | 2min
   4    | 10min
   5    | 1h
   6    | 6h
   7    | 12h
   8    | 24h
   ↓
   DEAD_LETTER
```

总累计窗口约 44 小时，对方运维只要在 1.5 天内修好就能自愈。超过 8 次连续失败的 endpoint 自动设 `disabledAt = now()` —— `consecutiveFailures` 字段累计，DELIVERED 时清零。

**结束条件**：

- `2xx` → DELIVERED（成功）
- `4xx`（除 408/429）→ DEAD_LETTER（语义错，重试无意义）
- `5xx` / 408 / 429 / 网络超时（默认 10s）→ RETRYING + 排下一次
- 第 8 次仍失败 → DEAD_LETTER

DEAD_LETTER 行 UI 上显眼标红，提供「手动重试」按钮（重置 attempt = 1, status = PENDING）。

### 2.5 v1 事件名单

```
subscription.created
subscription.updated
subscription.canceled
member.added              # 接受邀请进 org
member.removed            # OWNER/ADMIN 移除成员
member.role_changed       # 角色变更
audit.recorded            # 订阅审计的兜底通道；payload 含 action + metadata
```

每个事件的 payload schema 在 `/docs/api` 详尽列出。`audit.recorded` 是逃生口——任何 `recordAudit(...)` 的调用都会触发它（subject to enabledEvents 白名单）。这样客户即便我们没暴露具体事件类型，也能通过 audit 反向感知到。

### 2.6 UI

`/settings/organization/webhooks`（OWNER/ADMIN）—— 列表 + 创建 + 删除 + 重生 secret。

每个 endpoint 详情页 `/settings/organization/webhooks/[id]` 展示：

- 基本信息（URL / events / disabledAt / consecutiveFailures）
- 最近 50 条 deliveries 表格：eventType / status / attempt / response status / 时间
- 单条 delivery 展开看 payload + response body
- 「Resend」按钮：重置 attempt + nextAttemptAt = now()，重新跑投递

### 2.7 Sweep / 数据保留

Delivery 行行数膨胀风险——每事件每 endpoint 一行 + retry 不增行（行级状态机）。但累计 30 天后量级仍可观。

- DELIVERED / DEAD_LETTER / CANCELED 行 30 天后被 cron 删除（保留快照通过用户主动 `Resend` 是不靠谱的，30d 是合理的工业默认）。
- 待投递的 PENDING / RETRYING 永不删（按 nextAttemptAt 排）。
- Endpoint `consecutiveFailures` 累计可观测性指标（见 §6）。

---

## 3. OpenAPI 文档站

### 3.1 spec 来源：手写 YAML

权衡：

| 方案                                              | 优                            | 劣                                                            |
| ------------------------------------------------- | ----------------------------- | ------------------------------------------------------------- |
| 手写 `openapi/v1.yaml`                            | 稳定，文档即真相，PR-friendly | spec 与代码不强绑                                             |
| Zod → OpenAPI（`@asteasolutions/zod-to-openapi`） | 单一来源                      | 多依赖，每条路由必须改写描述，schema-to-spec mapping 总有边角 |
| `next-rest-framework` / 注解扫描                  | 完全自动                      | 改路由就改 spec，schema 飘忽，不便锁版本                      |

选**手写**。理由：

- `/api/v1/*` 路由数量小（v1 大概 8 条），手写文档 + lint 校验比生成稳。
- spec 是面向**集成商**的契约，应该比代码更稳定—— 改代码不应自动改 spec，反过来才对。
- CI 加一步 `redocly lint openapi/v1.yaml` 防止格式漂。

文件结构：

```
openapi/
├── v1.yaml                          # 主 spec 入口（OpenAPI 3.1）
├── components/
│   ├── schemas/                     # 复用的 schema 片段（可选，YAML refs）
│   │   ├── User.yaml
│   │   ├── Organization.yaml
│   │   └── Subscription.yaml
│   └── parameters/
└── README.md                        # 给集成商看的入门
```

### 3.2 渲染：Scalar

[Scalar](https://github.com/scalar/scalar) 是 2024 年涌现的轻量 OpenAPI 渲染器，比 Redoc 现代、比 Swagger UI 美观，且原生支持 RSC / Tailwind / dark mode。挂在 `/docs/api` 路由下：

```tsx
// src/app/[locale]/docs/api/page.tsx
import { ApiReference } from '@scalar/api-reference-react';
import openapi from '../../../../../openapi/v1.yaml';

export default function ApiDocsPage() {
  return <ApiReference configuration={{ spec: { content: openapi } }} />;
}
```

依赖增量：`@scalar/api-reference-react`（≈ 200KB gzipped）。否决备选：

- **Redoc**：体积大（≈ 1MB+），无 SSR-friendly React 包装。
- **Swagger UI**：UX 老旧，Tailwind 集成需要 hack。
- **Stoplight Elements**：质量高但绑定生态太重。

### 3.3 与 `/api/v1/*` 的对齐

每加一条公开端点必须**同步**改 `openapi/v1.yaml`。CI lint 步骤之外再加一条 e2e check：脚本扫描 `src/app/api/v1/**/route.ts`，把发现的路径与 spec 中的 `paths.*` 比对，缺口 → CI 红。

### 3.4 公开 API v1 完整列表（含本 RFC 新增）

```
# 现有（RFC 0001 PR-2）
GET    /api/v1/me

# RFC 0001 占位但本 RFC 完整接入 spec
GET    /api/v1/orgs/{slug}
GET    /api/v1/orgs/{slug}/members
POST   /api/v1/orgs/{slug}/invitations
GET    /api/v1/orgs/{slug}/invitations
DELETE /api/v1/orgs/{slug}/invitations/{id}
GET    /api/v1/orgs/{slug}/subscription

# RFC 0002 PR-3 占位（本 RFC 无新增，但写进 spec）
POST   /api/v1/me/exports
GET    /api/v1/me/exports
POST   /api/v1/orgs/{slug}/exports
GET    /api/v1/orgs/{slug}/exports
GET    /api/v1/me/exports/{id}/download

# RFC 0003 新增
GET    /api/v1/orgs/{slug}/webhooks
POST   /api/v1/orgs/{slug}/webhooks                           # 创建
PATCH  /api/v1/orgs/{slug}/webhooks/{id}                      # 改 url / events / disabledAt
DELETE /api/v1/orgs/{slug}/webhooks/{id}
POST   /api/v1/orgs/{slug}/webhooks/{id}/rotate-secret        # 重生 secret，明文返回一次
GET    /api/v1/orgs/{slug}/webhooks/{id}/deliveries           # 最近 50 条
POST   /api/v1/orgs/{slug}/webhooks/{id}/deliveries/{deliveryId}/resend
```

公共错误模型沿用 RFC 0001：`{ "error": "<machine_code>", "message"?: "..." }`，HTTP status 与 code 协调。

---

## 4. 数据模型变更总表

| 表 / 枚举               | 变更                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebhookEndpoint`       | 新表                                                                                                                                                 |
| `WebhookDelivery`       | 新表                                                                                                                                                 |
| `WebhookDeliveryStatus` | 新枚举                                                                                                                                               |
| `Organization`          | 加 `webhookEndpoints WebhookEndpoint[]` 反向关系                                                                                                     |
| `AUDIT_ACTIONS`         | + `webhook.endpoint_created` / `webhook.endpoint_updated` / `webhook.endpoint_deleted` / `webhook.secret_rotated` / `webhook.endpoint_auto_disabled` |

---

## 5. 迁移计划（拆 4 个 PR，每个独立可回滚）

### PR-1 Schema + Endpoint CRUD（无投递）

- 加表 + 枚举 + audit codes。
- `enqueueWebhook()` helper 写好但无人调（dead code 也行，下个 PR 接入）。
- Server action：create / update / delete / rotate-secret + Org 设置页 UI。
- Public API：`/api/v1/orgs/{slug}/webhooks*` 带 OpenAPI lint 设入。
- e2e：建 endpoint → list → rotate secret（明文一次性可见）→ delete。

### PR-2 投递流水线 + 重试

- `scripts/run-webhook-cron.ts`，复用 cron-claim 模式。
- HMAC 签名 + 时间戳头。
- v1 事件接入：在 `recordAudit` / `stripe.webhook` / membership actions 里调 `enqueueWebhook(...)`。
- Deliveries 列表 UI + payload preview。
- e2e：mock receiver（local express）+ 触发 subscription.created 事件 → 验证签名 + payload。

### PR-3 OpenAPI spec + Scalar 渲染

- 新增 `openapi/v1.yaml`，覆盖现有 + 本 RFC 所有端点。
- `pnpm openapi:lint` 命令（用 `@redocly/cli`）。
- `/docs/api` 渲染页（Scalar）。
- CI script `scripts/check-openapi-coverage.ts`：扫描 `src/app/api/v1/**/route.ts` vs spec paths。
- 文档示例：HMAC verify 三语言代码块（Node / Python / PHP）。

### PR-4 收尾 — Sweep + 自动禁用 + observability

- Sweep cron 30d 删除终态 deliveries。
- `consecutiveFailures ≥ 8` 自动 `disabledAt = now()` + 邮件通知 OWNER。
- Prometheus metrics：`webhook_deliveries_total{status}` 等（见 §7）。
- 文档站补全：rate limits / quotas / status page 链接。

回滚：每个 PR 都是加法或非破坏改造。PR-2 把 `enqueueWebhook` 嵌入业务路径——回滚需要先 revert 这部分调用，否则 enqueue 没消费者。

---

## 6. 权限矩阵补充

| Action                       |      OWNER       | ADMIN | MEMBER |
| ---------------------------- | :--------------: | :---: | :----: |
| 列出 / 查看 webhook endpoint |        ✓         |   ✓   |        |
| 创建 / 编辑 / 删除 endpoint  |        ✓         |   ✓   |        |
| 重生 secret                  |        ✓         |   ✓   |        |
| 查看 delivery 列表 + payload |        ✓         |   ✓   |        |
| 手动 resend 单条 delivery    |        ✓         |   ✓   |        |
| 浏览 `/docs/api`             | 公开（无需登录） |       |        |

---

## 7. 可观测性 / Metrics

```
kitora_webhook_endpoints_total{disabled}     # gauge by enabled/disabled
kitora_webhook_deliveries_total{status}      # counter（PENDING/.../DEAD_LETTER）
kitora_webhook_delivery_attempts_bucket{...} # histogram of retry attempts to terminal
kitora_webhook_response_seconds_bucket{status_class}
kitora_webhook_dead_letter_total             # counter — 排错告警基线
```

新增 audit action：

```
webhook.endpoint_created
webhook.endpoint_updated
webhook.endpoint_deleted
webhook.secret_rotated
webhook.endpoint_auto_disabled  # 由 cron 写，actor=null
```

---

## 8. 风险与对策

| 风险                                    | 对策                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| 接收端慢响应阻塞 cron worker            | 单次 fetch 默认 timeout 10s；BATCH 限 50；超时计入 RETRYING                                 |
| `WebhookDelivery` 行数失控              | 30 天 sweep + 单 endpoint 限 100 条 PENDING/RETRYING（超出新事件丢弃 + 写日志）             |
| 用户配错 URL（内部 IP / SSRF 风险）     | enqueue 前 DNS resolve 校验：拒绝私网 / 回环 / metadata IP（169.254.169.254 等）            |
| Secret 在 DB 泄露                       | 只存 `sha256(secret)`；明文仅在 create / rotate-secret 一次性返回；轮换后旧 secret 立即失效 |
| 重放攻击 / 时钟漂移                     | timestamp 头 + 5min 窗口；接收端 spec 文档明示                                              |
| 集成商无能力验签 → 安全降级要求"关签名" | 拒绝。spec 文档明示"签名是契约不是可选项"，提供三语言 sample code                           |
| OpenAPI spec 与代码漂移                 | CI 双卡：`redocly lint` + `scripts/check-openapi-coverage.ts`                               |
| 自动禁用骚扰 OWNER（network blip 误判） | `consecutiveFailures ≥ 8` 才禁用（≈ 2 天连续失败），且发邮件告诉 OWNER 怎么 reactivate      |
| 邮件 / 监控本身依赖 webhook → 死循环    | webhook cron 失败仅 log + Prometheus，不发任何额外 webhook                                  |
| 中国区 RoR 合规（数据外发到境外接收端） | endpoint URL 白名单留 RFC 0005 处理；本 RFC 仅记 `region` 字段占位                          |

---

## 9. 工作量估算

| PR   | 内容                                      | 估时  |
| ---- | ----------------------------------------- | ----- |
| PR-1 | Schema + Endpoint CRUD + UI + 公开 API    | 2 天  |
| PR-2 | 投递流水线 + 重试 + HMAC + 事件接入 + e2e | 3 天  |
| PR-3 | OpenAPI spec + Scalar 渲染 + CI 双卡      | 2 天  |
| PR-4 | Sweep + 自动禁用 + metrics + 文档收尾     | 1 天  |
| 合计 |                                           | ~8 天 |

---

## 10. 评审决策（2026-04-26 已定稿）

- [x] **投递通道** —— 复用 cron-claim（不引入 QStash / Inngest）。理由：与 RFC 0002 PR-3 一致，零新组件；按目标容量（10k deliveries / 天）有充分余量。容量瓶颈再换是后续 RFC 的事。
- [x] **签名方案** —— HMAC-SHA256（timestamp + body）+ 5 分钟 replay 窗口。理由：Stripe / GitHub / Slack 同款心智模型，集成商已熟；mTLS / JWT 提门槛无收益。
- [x] **OpenAPI spec 来源** —— 手写 YAML + CI lint。理由：spec 是面向集成商的契约，比代码更稳；自动生成的边角 case 总要手工兜底，不如直接写。
- [x] **doc 渲染器** —— Scalar。理由：体积、UX、SSR 友好都最佳；Redoc 太重，Swagger UI 老。
- [x] **事件粒度** —— v1 给 7 个具名事件 + `audit.recorded` 兜底。理由：具名事件提供良好的入门集成示例，audit 通道保证未覆盖到的场景仍然有发声渠道。
- [x] **Webhook 归属** —— 仅 per-org，不做 per-user。理由：B2B 集成全部以 org 为单位；user 级 webhook 是个体生产力工具的特征，不是 SaaS 模板的核心。
- [x] **DEAD_LETTER 通知** —— 自动禁用 + 邮件，不主动短信 / Slack 集成。理由：Slack 集成本身可以走 webhook 给客户端的 hook 处理，避免循环依赖。

待评审（暂保留默认建议）：

- [ ] **Webhook portal 镜像**（payload diff / signature debug 工具）—— v1 不做。等用户反馈再加。
- [ ] **多区域投递（区分 EU / US 出口 IP）**—— 留 RFC 0005「中国区」与「数据驻留」一并处理。

---

## 11. 后续 RFC 占位

- RFC 0004 — SSO（SAML / OIDC / SCIM）
- RFC 0005 — 中国区企业资质 / 多 ICP 备案 / 数据驻留
- RFC 0006 — WebAuthn / Passkey
- RFC 0007 — 数据保留策略 / Legal Hold / SOC 2 准备
- RFC 0008 — TypeScript / Python SDK 自动生成（基于本 RFC 的 OpenAPI spec）
