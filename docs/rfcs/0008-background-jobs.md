# RFC 0008 — 通用 Background Jobs 抽象

| 字段     | 值                                                        |
| -------- | --------------------------------------------------------- |
| 状态     | Draft                                                     |
| 起草人   | Kitora 工程组                                             |
| 起草日期 | 2026-04-26                                                |
| 目标版本 | v0.9.0                                                    |
| 依赖     | RFC 0002（数据导出）、RFC 0003（webhook）、RFC 0006（CN） |

---

## 1. 背景与目标

### 1.1 现状盘点

至 v0.8.0 落地，Kitora 的「异步活」是分散自写、外部 cron 触发的散点架构：

- 三个独立 CLI 脚本（`scripts/run-webhook-cron.ts` / `scripts/run-export-jobs.ts` / `scripts/run-deletion-cron.ts`），各自一套「claim → run → retry」模式；外部 Vercel / Fly Cron 每分钟（或每天，视任务）触发一次。
- 三个领域表（`WebhookDelivery` / `DataExportJob` / `User.deletionScheduledAt`）各自定义状态机：webhook 有 `PENDING/RETRYING/DELIVERED/DEAD_LETTER/CANCELED`、export 有 `PENDING/RUNNING/COMPLETED/FAILED/EXPIRED`、deletion 直接吃 `User.status` 列。
- WebhookDelivery 是其中最完整的：8 阶指数退避 `[0, 30s, 2m, 10m, 1h, 6h, 12h, 24h]`、`MAX_ATTEMPTS = 8`、永久失败（4xx 除 408/429）直接 DEAD_LETTER、连续 8 失败自动禁用 endpoint。
- 邮件（`src/lib/email/send.ts`）是 fire-and-forget：`sendEmail()` await 后吞错或 void，发失败没有任何后续。
- 限流（`src/lib/rate-limit.ts`）的滑窗维护在每次检查时同步完成（Upstash 自治，CN ioredis ZSET 在 MULTI 里清理），无独立 tick。
- Token 表过期清理（`PasswordResetToken` / `EmailVerificationToken`）靠「读时判断 `expiresAt < now()` 直接 ignore」，从不删行——每周 / 每月堆积上万行死数据。
- `BillingEvent` / Alipay / WeChat 入站 webhook 是同步处理（验签 → 复合唯一 dedup → upsert Subscription → recordAudit + enqueueWebhook），路由 handler 一次跑完。

无任何重型异步框架依赖：`package.json` 里没有 BullMQ / Inngest / QStash / pg-boss / Agenda / Temporal——这是有意选择，避免「一上来就引一个外部基础设施服务」。

### 1.2 痛点

- **CLI 脚本数量随 RFC 线性增长**：每加一类异步活就要新 CLI + 外部 cron 一个新条目。RFC 0009 / 0010 想象中的 metered billing dunning、audit log 异地复制、SCIM 用户同步、AI workload 等都会再加一个。
- **领域 sweep 与「一次性 ad-hoc 异步活」混用一套机制**：当下想做「3 秒后给某个 user 发一封提醒邮件」也得新建一张表 + 一个状态机 + 一个 worker 脚本，对一次性活的成本远超价值。
- **重试逻辑各自重写**：WebhookDelivery 的 8 阶退避表是 RFC 0003 自己写的；DataExportJob 至今没有重试（FAILED 就 FAILED，等用户手动重发）；邮件根本没重试。下一个写异步代码的人要么抄 webhook 那套要么从零再写，没有第三选择。
- **无中心可观测性**：现在「任务卡了 / DLQ 堆了」要分别去 `WebhookDelivery` 和 `DataExportJob` 两张表查；邮件失败完全不可观测。
- **无 schedule 注册表**：所有定时活靠外部 cron 字符串配置，代码层面看不到哪些活在跑、什么频率、是否互相冲突。一个新人接手要去 Vercel 项目设置 / Fly fly.toml / GitHub Actions workflow 三处对照才能全。

### 1.3 目标

引入**通用 background jobs 抽象层**，覆盖：

- **新增 `BackgroundJob` 表**：generic one-off 异步活的容器（`type` / `payload` / `status` / `attempt` / `nextAttemptAt` / `lockedBy` / `lockedAt` / `lastError` / `result` / `runId`）。
- **`defineJob<T>(...)` 类型化注册表**：每种 job 在代码里声明一次（`type` 名字、`payloadSchema` zod、`run` handler、可选 `retry` 策略、`maxAttempts`、`retentionDays`）。调用方仅需 `enqueueJob(type, payload, opts?)`。
- **`defineSchedule(...)` cron 注册表**：把所有定时活（包括现有 3 个 sweep tick + 新增的 token 清理 + 过期 BackgroundJob 行 prune）写在代码里，worker 启动时按 cron 表达式生成 BackgroundJob 行。
- **单一 CLI 入口 `scripts/run-jobs.ts`**：替代 3 个旧脚本（保留旧脚本作为 thin shim 兼容性），外部 cron 一次只调它。
- **首批接入业务**：邮件发送重试 wrapper、PasswordResetToken / EmailVerificationToken / 过期 Invitation 清理、过期 BackgroundJob 行 prune、Subscription dunning 占位（实际 metered billing 等 RFC 0009 再用）。
- **可观测性**：Sentry breadcrumbs、admin 后台 `/admin/jobs` 列出所有 type 与最近 100 行执行历史、metrics 钩子。

非目标（写明排除）：

- **不引入外部排队服务**（不用 Redis Streams / Kafka / RabbitMQ）。BackgroundJob 表用 PostgreSQL 的 `FOR UPDATE SKIP LOCKED` 做 claim，对 Kitora 当前规模（< 100 jobs/min）足够，RFC 0009+ 再视情况升级到 Redis Streams。
- **不引入 workflow engine**（不抄 Temporal / Inngest 的多步 workflow / sagas）。当下 90% 的活是「单步异步」，多步用「job 处理完后再 enqueue 下一个 job」就够。
- **不做 worker 长驻进程**（依旧外部 cron 触发 CLI 模式）。原因：Vercel serverless 模型不允许长驻、Fly + Aliyun ACK 上长驻进程的 ops 复杂度（重启、热更、资源回收）和当前规模不成正比。
- **不做用户面板的 jobs UI**（admin 内部页就够，普通用户不需要看到 jobs 概念）。
- **不做实时推送 / SSE / WebSocket**（与 jobs 正交，留给独立 RFC）。

---

## 2. 设计原则

承接 RFC 0001–0007 一脉相承的几条：

- **借坡下驴，不重写历史**：WebhookDelivery / DataExportJob / `User.deletionScheduledAt` 三套领域状态机**保留不动**——它们的状态机是业务一阶事实，不是 jobs infra 的抽象漏出。新 BackgroundJob 表只负责「调度它们的 sweep tick」+「承接全新的一次性 ad-hoc 活」。
- **降级先于扩展**：BackgroundJob 表凡是有未交付项（worker 崩溃、claim 漏抢、payload 太大），优先选「保守降级到读时再判断」而不是「再叠一层抽象」。`FOR UPDATE SKIP LOCKED` 抢到锁就跑、抢不到下一轮再来；不实现复杂的 priority queue / fairness。
- **调用方零样板**：业务代码只写 `enqueueJob('email.send', { to, subject, body })`——type 名字、payload 形状、retry 行为全在 `defineJob()` 一处声明。调用方不需要懂 worker 内部。
- **类型安全到 enqueue 边界**：`enqueueJob<T extends JobType>(type: T, payload: JobPayload<T>)` 在 TS 层就能拒绝错误的 payload，不靠运行时 schema 校验兜底（zod 仍跑，但当二道防线）。
- **可观测性是 first-class**：每个 job 执行都进 Sentry breadcrumb、metrics counter、admin 列表。调试一个失败 job 不用 grep 日志。

---

## 3. 数据模型变更

### 3.1 新表 `BackgroundJob`

```prisma
enum BackgroundJobStatus {
  PENDING
  RUNNING
  SUCCEEDED
  FAILED
  DEAD_LETTER
  CANCELED
}

model BackgroundJob {
  id            String              @id @default(cuid())

  /// `defineJob` 注册表里的 type 名字，例如 `email.send`、`token.cleanup`、`webhook.tick`。
  type          String

  /// 任意 zod 校验过的 JSON payload。
  payload       Json

  /// 业务侧给的幂等键。同 (type, runId) 在表里只能存在一行——重复 enqueue 直接拒，不报错。
  /// null 表示调用方不在意去重；多数 ad-hoc 活走这条。
  runId         String?

  status        BackgroundJobStatus @default(PENDING)
  priority      Int                 @default(0)        // 高优先级先抢；先按 priority desc 再按 nextAttemptAt asc。
  queue         String              @default("default") // 后续多 worker 想分队列时用，v1 永远 default。

  attempt       Int                 @default(0)
  maxAttempts   Int                 @default(5)        // defineJob 里覆盖；默认 5 次涵盖大多数活。
  nextAttemptAt DateTime            @default(now())    // 抢锁时 `WHERE nextAttemptAt <= now()`。

  /// 抢到锁的 worker 自报家门。崩溃恢复时按 lockedAt < now() - LOCK_TIMEOUT 标准把 RUNNING 翻回 PENDING。
  lockedBy      String?
  lockedAt      DateTime?

  /// 上次失败的错误（截断 2KB）。SUCCEEDED 时仍保留最后一次重试前的错误，方便 debug。
  lastError     String?

  /// run handler 返回的结果 JSON。SUCCEEDED 状态下可读；多数活返回 null。
  result        Json?

  createdAt     DateTime            @default(now())
  startedAt     DateTime?
  completedAt   DateTime?

  /// retention：终态行（SUCCEEDED / FAILED / DEAD_LETTER / CANCELED）按 defineJob.retentionDays 推一个 deleteAt 进来；prune job 扫这个列。
  deleteAt      DateTime?

  @@unique([type, runId], map: "background_job_type_run_unique")
  @@index([status, queue, priority, nextAttemptAt], map: "background_job_claim_idx")
  @@index([deleteAt], map: "background_job_prune_idx")
  @@index([type, status])
}
```

**索引设计要点**：

- `(status, queue, priority, nextAttemptAt)` 复合索引：worker claim 的查询是 `WHERE status = 'PENDING' AND queue = $1 AND nextAttemptAt <= now() ORDER BY priority DESC, nextAttemptAt ASC LIMIT $batch FOR UPDATE SKIP LOCKED`——索引顺序与 ORDER BY / WHERE 完全对齐。
- `(deleteAt)`：prune job 单列扫，b-tree range 查询。
- `(type, runId)` unique：去重的 hard guarantee；P2002 触发时调用方按「已存在等价 enqueue」处理，不报错。
- `(type, status)`：admin 后台 `/admin/jobs?type=email.send&status=FAILED` 这种过滤的常规索引。

**为什么不复用 WebhookDelivery / DataExportJob**：那两张表的状态机里塞了大量领域字段（`endpointId` / `deliveryId` / `signature` / `storagePath` / `sizeBytes`），泛化到 generic 容器会让两边都难看。BackgroundJob 是新表，与领域表正交。

### 3.2 不动的表

明确**不动**：

- `WebhookDelivery`：保留所有现有列与状态机；WebhookCron sweep tick 改为 `defineSchedule({ cron: '* * * * *', enqueue: 'webhook.tick' })`，job handler 内只是简单调 `runWebhookCronTick()`。
- `DataExportJob`：同上策略，`defineSchedule({ cron: '* * * * *', enqueue: 'export.tick' })`。
- `User.deletionScheduledAt`：同上，`defineSchedule({ cron: '0 3 * * *', enqueue: 'deletion.tick' })`（每天凌晨 3 点跑）。
- `BillingEvent` / `StripeEvent`：入站 webhook 处理路径不动，仍是 route handler 内同步处理。本 RFC 范围只接「dunning / 失败重试 / 退款异步对账」，那些是后续 RFC 0009 的事。

### 3.3 可选 schedule 持久化（v1 不做）

`defineSchedule` 在 v1 用**纯代码注册表**——worker 启动时遍历内存里的 schedule 列表，按 cron 表达式判断「上次运行时间 + interval ≤ now()」就生成一行 BackgroundJob。**不**单独建 `Schedule` 表，原因：

- schedule 是代码 invariant（部署什么版本就有什么 schedule），不是数据；建表反而会出现「DB 里有但代码里没」的孤儿行。
- 唯一需要持久化的是「每个 schedule 上次跑了什么时候」，这个塞进 BackgroundJob 表的最近一行 `(type='schedule:tokenCleanup', status='SUCCEEDED', completedAt DESC LIMIT 1)` 即可。

如果 RFC 0010+ 出现「运营人员需要在 admin 里临时禁用 / 修改某个 schedule」的需求，再补 `Schedule` 表。

---

## 4. 模块设计

### 4.1 核心 lib：`src/lib/jobs/`

```
src/lib/jobs/
├── define.ts        // defineJob<T>(...) / defineSchedule(...) + 类型导出
├── enqueue.ts       // enqueueJob(type, payload, opts) / cancelJob(id)
├── runner.ts        // claimAndRun(workerId, batchSize) — 一次 tick 的核心循环
├── retry.ts         // nextRetryDelayMs(attempt, strategy) — 默认指数退避，可覆盖
├── registry.ts      // 全局 JobRegistry 与 ScheduleRegistry（模块级 singleton）
├── prune.ts         // 过期 BackgroundJob 行 prune helper
├── observability.ts // Sentry / metrics / breadcrumbs 集成
└── jobs/            // 具体 job 定义文件
    ├── email-send.ts
    ├── token-cleanup.ts
    ├── webhook-tick.ts
    ├── export-tick.ts
    ├── deletion-tick.ts
    └── job-prune.ts
```

### 4.2 `defineJob` API 形态

```ts
// src/lib/jobs/jobs/email-send.ts
import { z } from 'zod';

import { defineJob } from '@/lib/jobs/define';
import { sendEmail } from '@/lib/email/send';

const payloadSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200),
  reactExportName: z.string(), // 序列化的 React 模板引用（避免存整 JSX 在 DB）
  templateProps: z.record(z.unknown()),
});

export const emailSendJob = defineJob({
  type: 'email.send',
  payloadSchema,
  maxAttempts: 5,
  retentionDays: 7,
  retry: 'exponential', // 'exponential' | 'fixed' | { strategy: 'custom', delays: [...] }
  async run({ payload, attempt, jobId, logger }) {
    // payload 已经被 zod 校验过，这里直接用
    const reactNode = await loadReactTemplate(payload.reactExportName, payload.templateProps);
    await sendEmail({
      to: payload.to,
      subject: payload.subject,
      react: reactNode,
    });
    logger.info({ jobId, to: payload.to }, 'email-job-sent');
    return { ok: true };
  },
});
```

调用侧：

```ts
import { enqueueJob } from '@/lib/jobs/enqueue';

await enqueueJob('email.send', {
  to: user.email,
  subject: 'Welcome',
  reactExportName: 'WelcomeEmail',
  templateProps: { name: user.name },
});
```

`enqueueJob` 的 TS 签名通过 conditional types 把 `type` 与对应 `payloadSchema` 的 `z.infer<...>` 绑定——给错 payload 在 TS 编译期就 fail。

### 4.3 `defineSchedule` API 形态

```ts
// src/lib/jobs/jobs/webhook-tick.ts
import { defineJob, defineSchedule } from '@/lib/jobs/define';
import { runWebhookCronTick } from '@/lib/webhooks/cron';

export const webhookTickJob = defineJob({
  type: 'webhook.tick',
  payloadSchema: z.object({}),
  maxAttempts: 1, // sweep tick 不重试，下一分钟自然会再触发
  retentionDays: 1,
  async run() {
    await runWebhookCronTick();
    return null;
  },
});

defineSchedule({
  name: 'webhook-sweep',
  cron: '* * * * *', // 每分钟
  jobType: 'webhook.tick',
  payload: {},
});
```

worker 启动时把 ScheduleRegistry 里所有 schedule 投影成「下一次该跑的时间」，按到时生成 BackgroundJob 行。**重复触发的去重**靠 `runId` 列：每次 schedule 触发的 `runId = '<scheduleName>:<unixMinute>'`，复合 unique 让重复触发自动 swallow。

### 4.4 `runner.ts` claim 算法

```ts
async function claimNext(workerId: string, batch = 5): Promise<BackgroundJob[]> {
  // 一次 tick 抢最多 batch 行；用 SKIP LOCKED 让多 worker 不互锁。
  return prisma.$queryRaw<BackgroundJob[]>`
    UPDATE "BackgroundJob"
    SET "status" = 'RUNNING',
        "lockedBy" = ${workerId},
        "lockedAt" = NOW(),
        "startedAt" = COALESCE("startedAt", NOW()),
        "attempt" = "attempt" + 1
    WHERE "id" IN (
      SELECT "id" FROM "BackgroundJob"
      WHERE "status" = 'PENDING'
        AND "queue" = 'default'
        AND "nextAttemptAt" <= NOW()
      ORDER BY "priority" DESC, "nextAttemptAt" ASC
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;
}
```

**崩溃恢复**：每次 tick 进入前先把 `RUNNING + lockedAt < now() - 5min` 的行翻回 PENDING（同 WebhookDelivery / DataExportJob 现有套路）。这条恢复 query 走 `(status, lockedAt)` 的 partial 思路——v1 跑全表扫即可（RUNNING 行通常 < 100 个）。

**重试**：handler 抛错时（含 zod 校验失败），按 `defineJob.retry` 算下次时间，回 PENDING；`attempt >= maxAttempts` 时翻 DEAD_LETTER（保留 `lastError` 给 admin 排查）。

### 4.5 单一 CLI 入口 `scripts/run-jobs.ts`

```ts
#!/usr/bin/env tsx
import './bootstrap-jobs'; // 副作用：调所有 jobs/*.ts 触发 defineJob 注册

import { logger } from '@/lib/logger';
import { runWorkerTick } from '@/lib/jobs/runner';
import { fireSchedules } from '@/lib/jobs/schedules';
import { pruneCompletedJobs } from '@/lib/jobs/prune';

async function main() {
  const workerId = `worker-${process.pid}-${Date.now()}`;

  // 1. 把到点的 schedule 投影成新 BackgroundJob 行（去重靠 runId）。
  await fireSchedules();

  // 2. 抢一批 PENDING 行跑掉。
  const result = await runWorkerTick(workerId, { batchSize: 10, timeoutMs: 50_000 });
  logger.info({ ...result, workerId }, 'jobs-tick-done');

  // 3. prune 终态过期行。
  await pruneCompletedJobs();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'run-jobs-fatal');
    process.exit(1);
  });
```

外部 cron 配置（如 Vercel `vercel.json` 的 `crons`、Fly `fly.toml` 的 `[[services]] processes`、Aliyun ACK 的 CronJob）只需配一条：每分钟跑一次 `pnpm tsx scripts/run-jobs.ts`。

旧 3 个脚本（`run-webhook-cron.ts` / `run-export-jobs.ts` / `run-deletion-cron.ts`）**保留作为 thin shim**：内容退化为「调用对应的 sweep 函数 + 退出码」——这样部署侧的 Vercel Cron 配置可以无缝迁，等下个 minor 再删。

### 4.6 与现有领域 cron 的协调

| 旧脚本                       | 触发频率 | RFC 0008 后                                                       |
| ---------------------------- | -------- | ----------------------------------------------------------------- |
| `run-webhook-cron.ts`        | 每分钟   | `defineSchedule({ cron: '* * * * *', jobType: 'webhook.tick' })`  |
| `run-export-jobs.ts`         | 每分钟   | `defineSchedule({ cron: '* * * * *', jobType: 'export.tick' })`   |
| `run-deletion-cron.ts`       | 每天凌晨 | `defineSchedule({ cron: '0 3 * * *', jobType: 'deletion.tick' })` |
| **新增** token cleanup       | 每小时   | `defineSchedule({ cron: '0 * * * *', jobType: 'token.cleanup' })` |
| **新增** BackgroundJob prune | 每天     | `defineSchedule({ cron: '0 4 * * *', jobType: 'job.prune' })`     |

`webhook.tick` / `export.tick` / `deletion.tick` 这三个 job 的 `run` 函数就是 thin wrapper（调原 sweep 函数），不重写既有逻辑——这是 §2「借坡下驴」原则的具体落地。

### 4.7 邮件重试 wrapper

`sendEmail()` 不改签名（保持同步 await，failure 抛错给调用方决定），但新增一个 `enqueueEmail(payload)` 公开 helper：

```ts
import { enqueueJob } from '@/lib/jobs/enqueue';

// 业务代码以前直接 await sendEmail(...)；现在「应失败重试」的场景（密码重置、邀请、数据导出就绪）改用：
await enqueueEmail({ to, subject, reactExportName: 'PasswordReset', templateProps });
```

强一致场景（注册流的「立刻发验证邮件，否则用户卡住」）继续直接用 `sendEmail()`——重试需要 30 秒 + 2 分钟的退避，对那种活太慢。RFC 中明确两类的边界。

### 4.8 Admin 可观测性

新增 `/admin/jobs` 页面（`src/app/[locale]/(admin)/admin/jobs/page.tsx`）：

- Tab 1「类型」：每种 type 的成功率 / 平均耗时 / 最近 24h 失败数。
- Tab 2「最近执行」：最近 100 行 BackgroundJob，可按 `type / status / runId` 过滤。
- Tab 3「DEAD_LETTER」：所有 DEAD_LETTER 行 + 「重试」/「取消」按钮（admin manual 救援）。

Sentry / metrics 集成：

- 每个 job run 包一层 Sentry transaction（`{ op: 'job', name: payload.type }`）。
- Counter：`jobs.success.total{type=}`、`jobs.failure.total{type=}`、`jobs.dlq.total{type=}`。
- Histogram：`jobs.duration.ms{type=}`。

---

## 5. 部署 / Worker 模型

### 5.1 沿用「外部 cron 触发 CLI」

这是 v1 的明确选择。理由：

- **Vercel serverless / Fly micro-VM 上长驻进程的 ops 复杂度**远超当前规模收益。当 Kitora 的 jobs/min 突破 1000 时再切到长驻 worker（届时单 tick 跑不完），那是 RFC 0010+ 的事。
- **每分钟一次 tick 的延迟下界 ≤ 60 秒**对所有当前 job 都够。邮件、token 清理、sweep tick 没有亚分钟时延需求。
- **Vercel Cron** 已经免费，每个项目支持 40 个 schedule（Pro 是 100 个）。我们整个 RFC 只用 1 个 schedule（统一调 `run-jobs.ts`），剩余配额留给 RFC 0009+。

部署侧需要新增的事：

- Vercel：`vercel.json` 加 `{"crons": [{"path": "/api/jobs/tick", "schedule": "* * * * *"}]}`，对应一个新路由 `/api/jobs/tick` 内部就调 `runWorkerTick + fireSchedules + pruneCompletedJobs`（避免维护两个入口：CLI 给 Fly / Aliyun 用、HTTP 给 Vercel 用）。
- Fly：`fly.toml` 不变（Fly Machines Cron 还是命令行）。
- Aliyun ACK：`infra/aliyun/cronjob.yaml`（RFC 0006 的 follow-up）配一条 `pnpm tsx scripts/run-jobs.ts` 即可。

### 5.2 单 tick 时长上限

每次 tick 给 50 秒预算（Vercel Hobby 的 max function duration 是 10s、Pro 是 60s、Enterprise 自定）。`runWorkerTick` 内部按 batch 抓 5–10 个 job，每个 job 自己有 `defineJob.timeoutMs`（默认 10s）；任何 job 超时算重试。

整个 tick 的硬上限通过 `AbortController` 控制：剩余预算 < 单 job timeoutMs 时不再 claim 新 job，让本次 tick 优雅结束。

### 5.3 多 worker 并发

`FOR UPDATE SKIP LOCKED` 是 v1 多 worker 安全的钢底——任意数量的 worker 并发 tick 都不会重复抢同一行。Vercel Cron 一次只起一个 invoke，但 Fly 多 region 部署可能并发，Aliyun ACK 多 pod 同样。

### 5.4 监控

复用 RFC 0006 PR-4 的 metrics 钩子：

- `jobs.tick.duration.ms`（一次 tick 总耗时）
- `jobs.tick.claimed.count`（每次 tick 抢到的行数）
- `jobs.tick.dlq.count`（每次 tick 进 DLQ 的行数；非零应告警）
- `jobs.queue.lag.seconds`（最老 PENDING 行的 createdAt 距 now 多久）

---

## 6. PR 拆分

| PR   | 范围                                                                                                                                                                                                                 | 估时   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| PR-1 | Schema 迁移（`BackgroundJob` 表 + 索引）+ `src/lib/jobs/{define,enqueue,runner,retry,registry,observability}.ts` 核心 lib + `defineJob` / `enqueueJob` / `runWorkerTick` 实现 + 单元测试覆盖 claim / 重试 / 崩溃恢复 | 2 天   |
| PR-2 | `defineSchedule` + `scripts/run-jobs.ts` + 三个旧 cron 迁移成 thin wrapper job（`webhook.tick` / `export.tick` / `deletion.tick`）+ 旧脚本退化为 shim                                                                | 1 天   |
| PR-3 | 接入第一批新 jobs：`token.cleanup`（清 PasswordResetToken / EmailVerificationToken / 过期 Invitation）、`job.prune`（清 BackgroundJob 终态过期行）、`email.send`（重试 wrapper）+ audit `job.*` 动作字符串           | 1.5 天 |
| PR-4 | Admin 后台 `/admin/jobs` 页面 + Sentry / metrics 集成 + Vercel Cron `/api/jobs/tick` 路由 + Fly / Aliyun 部署文档更新                                                                                                | 1.5 天 |
| PR-5 | i18n（en / zh）+ e2e（enqueue → tick → succeeded / DLQ / cancel 4 个 case）+ docs/rfcs/0008 §11 实施完成回填 + CHANGELOG `[0.9.0]`                                                                                   | 1 天   |
| 合计 |                                                                                                                                                                                                                      | ~7 天  |

每个 PR 的不变量：不跨「lib + schedule 注册 + 业务接入」三层；schema migration 始终在 PR-1。

### 6.1 回滚

- PR-1 的 schema migration：纯加表 + 加索引，零停机；回滚需要 drop 表（无外键依赖）。
- PR-2：旧脚本仍保留 thin shim，把 Vercel / Fly cron 切回旧脚本即可。
- PR-3 / PR-4：每个新 job / 新页面独立可回滚；下线 schedule = 删 `defineSchedule(...)` 一行 + 部署。
- PR-5：纯文档 + e2e + i18n。

---

## 7. 风险与对策

| 风险                                                           | 对策                                                                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单 worker tick 抓太多行超时，剩余 RUNNING 行卡 5 分钟          | tick 内部按剩余预算决定是否再 claim；崩溃恢复阈值默认 5 分钟可调；DEAD_LETTER 优先看 `lockedAt < lockedAt of last successful run` 判定卡顿。          |
| `FOR UPDATE SKIP LOCKED` 在 PgBouncer transaction 池下行为异常 | 用 session 池或 statement 池；Prisma 默认 `?pgbouncer=true` 在事务模式下安全（已在 RFC 0001 PR-1 验证）。文档里写明 PG 11+ 才稳定。                   |
| 长 payload 撑爆 `payload Json` 列（PG 默认 jsonb 1GB 上限）    | `defineJob` 强制单 payload < 64KB（zod 序列化后字节数 check）；超出请把 payload 落 storage、表里只放 ref（pattern 与 RFC 0002 数据导出一致）。        |
| schedule 注册表 vs 实际部署 drift（代码里有但 cron 没触发）    | `runWorkerTick` 自身就是 schedule 触发入口（fireSchedules 在每次 tick 头部调），不依赖外部 cron 维护一致——只要外部 cron 在调 `run-jobs.ts` 就齐全。   |
| Vercel Hobby 10s 限制下 tick 跑不完                            | `defineJob.timeoutMs` 默认 8s（< 10s）；batch 默认 5（共 40s）；剩余 2s 余量。生产建议 Pro 以上；Hobby 仅用于 demo。                                  |
| 历史活的语义被 jobs 框架破坏（webhook 重试间隔被改）           | `webhook.tick` 等 sweep 类 job 的 `run` 函数仅调用既有 `runWebhookCronTick()`，retry / DLQ / 退避**全在领域代码内**——本框架对它们透明。               |
| 邮件 enqueue 后由于 worker tick 间隔造成「30 秒级延迟」        | 强一致场景（注册验证邮件、密码重置邮件）继续走 `sendEmail()` 同步——只把 fire-and-forget 的活（数据导出就绪、webhook 自禁用通知）切到 `enqueueEmail`。 |
| `runId` 重复 unique 冲突阻塞 enqueue                           | `enqueueJob` 显式 try/catch P2002，对调用方表现为「等价 enqueue 已存在」（noop 成功）；不抛错。                                                       |
| BackgroundJob 表无限增长撑爆磁盘                               | `defineJob.retentionDays` 默认 7 天，结合 `(deleteAt)` 索引 + `job.prune` 每天扫；admin 页同时显示当前表行数。                                        |

---

## 8. 工作量与时间表

```
Day 1-2   ┃ PR-1：schema + 核心 lib + 单元测试
Day 3     ┃ PR-2：schedule + 单一 entry + 三脚本迁移
Day 4-5   ┃ PR-3：首批新 jobs（token / prune / email）
Day 6-7   ┃ PR-4：admin / Sentry / Vercel Cron 路由
Day 8     ┃ PR-5：i18n + e2e + RFC 收尾
```

合计：**~7–8 工程日**（无外部基础设施依赖，无监管流程）。

---

## 9. 评审决策（2026-04-26 已定稿）

- [x] **是否同时建 `Schedule` 表** — v1 **不建**，纯代码注册表。理由：schedule 是代码 invariant（部署什么版本就有什么 schedule），不是数据；建表反而会出现「DB 里有但代码里没」的孤儿行。如果 ops 临时需要禁用某个 schedule，走 admin 页「override 当前 process 内存 schedule」（一次部署内有效）；持久 override 留给 RFC 0010。
- [x] **`runId` 命名约定** — 调用方**自由**，框架不强约束格式。理由：业务幂等键多种多样（`subscription:${id}:dunning`、`user:${id}:cleanup-orphans`、`schedule:tokenCleanup:<unixMinute>`），强约定反而碍事。`docs/rfcs/0008` 与 `src/lib/jobs/define.ts` JSDoc 各给一段 best practice（建议形如 `<domain>:<entityId>:<action>`，schedule 触发用 `schedule:<scheduleName>:<unixMinute>`）。
- [x] **失败时是否自动发邮件给 admin** — v1 **不做**自动告警邮件。理由：admin `/admin/jobs` 页已有 DLQ 数字 + Sentry transaction + metrics counter `jobs.dlq.total{type=}` 进 RFC 0006 dashboards，覆盖度足够；自动邮件容易扰民、阈值难调。如真出现 DLQ 飙升，RFC 0010 再补统一告警通道（含 PagerDuty / IM webhook）。
- [x] **payload 序列化格式** — **Json (jsonb)**，不上 MessagePack。理由：可读、admin 页可直接渲染、Prisma `Json` 列原生支持；与 MessagePack 在 64KB 上限内的占用差异没有数量级，可读性收益完胜。`defineJob` 强制单 payload zod 序列化后字节数 < 64KB（与 RFC 0002 数据导出 payload 大小限制对齐）。
- [x] **多 queue 在 v1 是否暴露** — **暴露 `queue` 列与 `defineJob({ queue })` API**，但 worker v1 只 claim `queue = 'default'`。理由：留出接口避免 v2 改 API 破坏调用方；v1 实际不用多 queue（RFC 0009/0010 真有「dunning 高优 / audit 复制低优」分流需求时再启用）。
- [x] **Vercel Cron 路径** — **`/api/jobs/tick`**，通过 `Authorization: Bearer ${CRON_SECRET}` 鉴权。理由：与 `src/lib/jobs/` lib 命名一致；CRON_SECRET env 仅 Vercel Cron 注入，外部访问统一返回 401（不泄露路径存在性，沿用 RFC 0003 webhook tick 同款模式）。CLI（Fly / Aliyun ACK）走 `pnpm tsx scripts/run-jobs.ts` 不经 HTTP。
- [x] **是否引入 `priority` 列的实际语义** — **保留 `priority Int` 列、v1 全用默认 0**。理由：claim 索引 `(status, queue, priority, nextAttemptAt)` 已包含该列，无额外成本；v1 高优场景太少，等 RFC 0010 metered billing dunning / SCIM 实时同步等场景出现时再启用 100 / 200 / 500 等档位。
- [x] **失败 job 的告警阈值** — DLQ 当 RFC 0006 metrics **一等公民**。理由：DLQ 增长是平台健康度核心指标（jobs 卡住 → 邮件不发 → token 不清 → 用户体感故障），与 webhook 失败率、export 卡顿、CN audit-egress 拦截属同级别。`jobs.dlq.total{type=}` counter + `jobs.queue.lag.seconds` gauge 直接进 dashboards。

---

## 10. 与历史 RFC 的衔接

- **RFC 0001（Organizations）**：不动。BackgroundJob 是平台级表，不挂 org。`payload` 内部可以放 `orgId`，但表本身不索引。
- **RFC 0002（数据导出 / Active Sessions / 删除）**：DataExportJob / `User.deletionScheduledAt` 状态机不动；新增 `export.tick` / `deletion.tick` 两个 schedule job 调原 sweep 函数。删除流程的 30 天 grace 期由 schedule 每天触发不变。
- **RFC 0003（出站 webhook / OpenAPI）**：WebhookDelivery 表不动；新增 `webhook.tick` schedule job 调 `runWebhookCronTick()`。`/api/jobs/tick` 不进 OpenAPI（内部端点）。
- **RFC 0004（SSO）**：不动。SSO JIT 是同步流，不接 jobs。
- **RFC 0005（Multi-region）**：BackgroundJob 表 region-bound（CN region 单独的 PG 实例有自己的 BackgroundJob 行）；payload 内部如果引用跨 region 实体（`storagePath`、邮件地址）由调用方负责。
- **RFC 0006（CN 区落地）**：CN region 的 worker 以 Aliyun ACK CronJob 调 `pnpm tsx scripts/run-jobs.ts`；`infra/aliyun/cronjob.yaml`（RFC 0006 follow-up）由本 RFC 的 PR-4 顺手补上。`audit-egress` 闸不影响——所有 job handler 仍跑在区域内。
- **RFC 0007（WebAuthn / Passkey）**：不动。passkey 是同步流。

---

## 11. 实施完成（v0.9.0 工程交付）

> 全部 5 个 PR 已合入主干并随 v0.9.0 发版。Background jobs 抽象层默认就生效（webhook / export / deletion 三个既有 sweep tick 自动改走 wrapper job + `fireSchedules` 投影），但**部署侧 cron 配置需要切换**到 `pnpm tsx scripts/run-jobs.ts`（自托管）或 Vercel `vercel.json` 的 `/api/jobs/tick` 路由（Vercel）；旧 `run-webhook-cron.ts` / `run-export-jobs.ts` / `run-deletion-cron.ts` 三脚本保留 thin shim 一个 minor，外部 cron 配置可平滑迁移。

工程交付清单（按 PR 排）：

- **PR-1**（schema + 核心 lib + 单元测试）—— `prisma/migrations/20260601200000_add_background_job/`、`prisma/schema.prisma`（`BackgroundJob` 表 + `BackgroundJobStatus` enum + 4 个索引：`(type, runId)` unique / `(status, queue, priority, nextAttemptAt)` claim 热路径 / `(deleteAt)` prune / `(type, status)` admin filter）、`src/lib/jobs/{registry,define,enqueue,runner,retry,observability}.ts` 6 个核心 lib 共 844 行（registry singleton 走 `globalThis[Symbol.for('kitora.jobs.registry.v1')]`、`runner.ts` 用 `prisma.$queryRaw` 跑 `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`、claim 时同步 bump `attempt` 让 retry 决策一致）、`src/lib/jobs/{registry,define,enqueue,retry,observability}.test.ts` 5 个 vitest 单测共 562 行；`vitest.config.ts` + `package.json` 加 `vitest@^2.1.8` devDep + `test:unit` / `test:unit:watch` 两个 npm script。
- **PR-2**（defineSchedule + 单一 CLI + 三脚本迁移）—— `src/lib/jobs/cron.ts`（minimal cron matcher，无外部 dep，支持 `*` / `N` / `N-M` / `*\/N` / `N-M/K` / 列表，UTC 时区，标准 Vixie cron dom/dow OR 合）、`src/lib/jobs/schedules.ts`（`fireSchedules(now?)` 投影主入口，runId = `schedule:<name>:<unixMinute>` 走 P2002 swallow 自然去重）、`src/lib/jobs/jobs/{webhook-tick,export-tick,deletion-tick}.ts` 三个 thin wrapper job 调既有 `runWebhookCronTick` / `runExportJobsTick` / `runDeletionCronTick`、`src/lib/jobs/bootstrap.ts` import barrel、`scripts/run-jobs.ts` CLI 单一入口；`refactor` 把 `scripts/run-export-jobs.ts` / `run-deletion-cron.ts` 主体逻辑分别抽到 `src/lib/data-export/cron.ts` 与 `src/lib/account/deletion-cron.ts`，旧脚本退化为 thin shim（与既有 `run-webhook-cron.ts` 同结构）；`src/lib/jobs/{cron,schedules}.test.ts` 单测。
- **PR-3**（首批新 jobs）—— `src/lib/audit.ts` `AUDIT_ACTIONS` 加 `job.cancelled` / `job.retried` 两个 action（runner 自身**不**为 DEAD_LETTER 写 audit，仅 admin 手动操作时写）；`src/lib/jobs/jobs/token-cleanup.ts`（cron `0 * * * *` 每小时，`Promise.all` 并发清 PasswordResetToken / EmailVerificationToken `consumedAt 非空 OR expires < now()-7d` + Invitation `accepted/revoked OR expiresAt < now()-30d` 三表）、`src/lib/jobs/jobs/job-prune.ts`（cron `0 4 * * *` 每天 UTC 04:00，`status in 4 终态 AND deleteAt < now()` defensive filter）、`src/lib/jobs/jobs/email-send.ts`（zod `discriminatedUnion('template')` 覆盖 `password-reset` / `org-invitation` / `data-export-ready` 三模板，`enqueueEmail(payload, opts?)` typed helper，`maxAttempts: 5` + `retry: 'exponential'` 5 阶退避）+ 三对应 `*.test.ts` 单测；`bootstrap.ts` 加 3 行 import 触发副作用注册。
- **PR-4**（admin / Sentry / Vercel Cron 路由 / 部署文档）—— `src/env.ts` 加 `CRON_SECRET: z.string().min(32).optional()`；`src/app/api/jobs/tick/route.ts`（GET 路由，503 / 401 / 200 / 500 四档，`Authorization: Bearer ${CRON_SECRET}` 严格匹配，`maxDuration = 60`）+ `vercel.json` `crons: [{ path: '/api/jobs/tick', schedule: '* * * * *' }]`；`src/app/[locale]/(admin)/admin/jobs/page.tsx` 三 Tab（overview 含 24h `groupBy(type, status)` pivot 表 + DLQ / queueLag 自动 warn 着色 / recent 含 type+status 双轴过滤 / dlq 含 retry+cancel 行级按钮）+ `loading.tsx`；`src/components/admin/jobs/job-row-actions.tsx` 客户端按钮（`useTransition` + sonner toast + i18n + cancel 走 confirm()）；`src/components/admin/admin-nav.tsx` 加 `ListTodo` icon + `/admin/jobs` 入口；`src/lib/admin/actions.ts` 追加 `cancelJobAction({ jobId })` + `retryJobAction({ jobId })` 两个 server actions（`requireAdmin` gate + `recordAudit({ action: 'job.cancelled' / 'job.retried' })` + `revalidatePath('/admin/jobs' + '/admin/audit')`）；`src/lib/jobs/observability.ts` 把 v1 占位的 `withJobTransaction` 替换为真实 `Sentry.startSpan({ op: 'job', name, attributes: { 'job.id', 'job.attempt' } })` + `Sentry.captureException(err, { tags: { jobType }, extra: { jobId, attempt } })`，dynamic import + try/catch fallback 兼容 tsx CLI / vitest 环境；`messages/{en,zh}.json` 加 `admin.nav.jobs` + `admin.jobs.{tabs, overview, status, recent.totalHint, dlq.intro, table, actions}` 完整文案；`docs/deploy/{global,cn,eu}.md` 加 `## Background jobs cron` 部署段（Vercel cron / Aliyun ACK CronJob YAML / EU 占位）。
- **PR-5**（i18n + e2e + RFC / CHANGELOG 收尾）—— `tests/e2e/jobs.spec.ts`（5 个 case：SUCCEEDED / retry / DEAD_LETTER / cancelJob / runId-dedup，走真 PG 验证状态机转移，每 test 用 unique `e2e.test-<rand>` jobType 名避免 registry 冲突）；本节回填；`CHANGELOG.md` `[0.9.0]` 段；`package.json` 0.8.0 → 0.9.0。
- **未交付**（RFC §1.3 / §6 / §9 已声明的非目标 / v1 不做）：
  - 外部排队服务（Redis Streams / Kafka / RabbitMQ）—— RFC §1.3 明确不引；当 jobs/min 突破 1000 时再升级到 Redis Streams（RFC 0010+）。
  - workflow engine（Temporal / Inngest 多步 workflow / saga）—— RFC §1.3 明确不抄；多步用「job 处理完后再 enqueue 下一个」就够。
  - 长驻 worker 进程 —— v1 仍走「外部 cron 触发 CLI」（Vercel Cron 路由 / Fly Machines Cron / Aliyun ACK CronJob）；K8s `concurrencyPolicy: Forbid` 解决并发问题。
  - 用户面板的 jobs UI —— admin 内部页（`/admin/jobs`）已交付，普通用户不看 jobs 概念。
  - SSE / WebSocket 实时推送 —— 与 jobs 正交，留给独立 RFC。
  - `Schedule` 持久化表 —— §9 决策为不建，schedule 是代码 invariant 而非数据。
  - DLQ 自动告警邮件 —— §9 决策 v1 不做，admin 页 + Sentry / metrics 已覆盖。
  - 多 queue 实际语义 —— §9 决策保留 `queue` 列与 `defineJob({ queue })` API 但 worker 永远 claim `default`；RFC 0010 真有分流需求时再启用。
  - `priority` 列实际语义 —— 同上，列保留、v1 全用默认 0。
  - 真 PG SKIP LOCKED 多 worker 互不抢的并发测试 —— 推到 e2e（PR-5 `jobs.spec.ts`）lib-level 验证；多 worker 并发场景由 PG 保证（已在 RFC 0001 PR-1 验证 `pgbouncer=true` 在事务模式下安全）。
- **决策回填**（§9 待评审项 → 已定稿）：
  - ✅ Schedule 表不建（PR-1 `src/lib/jobs/registry.ts` 纯代码 singleton，HMR / forks pool / tsx 都走 `globalThis[Symbol.for('kitora.jobs.registry.v1')]`）。
  - ✅ runId 自由命名（`enqueueJob` 的 `EnqueueOptions.runId?` 不约束格式，文档建议 `<domain>:<entityId>:<action>`；schedule 触发自动生成 `schedule:<name>:<unixMinute>` 后缀，PR-2 `schedules.ts`）。
  - ✅ DLQ 自动邮件 v1 不做（admin DLQ Tab + `jobs.dlq.total{type=}` Sentry counter 覆盖）。
  - ✅ payload Json (jsonb) + 64KB 上限（PR-1 `enqueue.ts` `PAYLOAD_BYTE_LIMIT = 64 * 1024` + 序列化字节数 check）。
  - ✅ 多 queue API 暴露 + v1 worker 只 claim default（PR-1 `define.ts` 留 `queue?` 字段，`runner.ts` 的 `claimNext` 接 `queue` 参数）。
  - ✅ Vercel Cron 路径 = `/api/jobs/tick` + `CRON_SECRET` 鉴权（PR-4 `route.ts` + `vercel.json` + `env.ts CRON_SECRET`）。
  - ✅ priority 列保留默认 0（PR-1 schema + `(status, queue, priority, nextAttemptAt)` claim 索引）。
  - ✅ DLQ 进 RFC 0006 metrics 一等公民（PR-1 `observability.ts` `JobMetricsHook.onDeadLetter` + `jobs.dlq.total{type=}` counter + `jobs.queue.lag.seconds` gauge 与 webhook / audit-egress 同级别上 dashboard）。
- **首日观测指标**（生产开启 `/api/jobs/tick` 路由后回填）：tick 完成时长（`jobs.tick.duration.ms` p50 / p99）、每 tick 抢到行数（`jobs.tick.claimed.count`，理想 0-batch / 非空时 ≤ batchSize=5）、按 type 分布的成功率（`jobs.success.total{type=} / (success + failure)`）、DLQ 增长率（`jobs.dlq.total{type=}` 24h 增量，> 5 即排查）、queue lag（最老 PENDING 行 `createdAt` 距 now，> 120s 即报警）、首批迁入 type 的 retry 模式分布（webhook 老的 8 阶曲线 vs `email.send` 新 5 阶 vs `token.cleanup` / `job.prune` / `*.tick` 的 fixed=60s）、Sentry transaction `op: 'job'` 的按 `jobType` tag 切片 latency 分布。
