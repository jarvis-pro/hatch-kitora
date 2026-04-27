# 部署 — GLOBAL 区域 (kitora.io)

> **状态**: 生产运维手册 —— 这是当前驱动 kitora.io 的配置。搭建新的 GLOBAL 环境（预发、私有化演示或全新替换）时请严格对照此文档。

GLOBAL 栈覆盖中国大陆和 EU 数据驻留客户之外的所有用户。它是 v0.6 唯一正式上线的区域 —— CN 栈等待 RFC 0006 落地（及 ICP 备案）；EU 目前是占位符，有付费客户需求时再激活。

## 拓扑结构

```
                ┌───────────────────────────────────────┐
                │       kitora.io  (region: GLOBAL)     │
                │                                       │
   browsers ───▶│  Vercel / Cloud Run (Node 22)         │
                │   ▲                                   │
                │   │   ENV: KITORA_REGION=GLOBAL       │
                │   ├── Postgres (Neon / Supabase, us-east) │
                │   ├── Redis (Upstash, us-east)        │
                │   ├── Object storage (S3 us-east-1)   │
                │   ├── Email (Resend)                  │
                │   ├── Billing (Stripe)                │
                │   └── Logs/Errors (Sentry)            │
                └───────────────────────────────────────┘
```

所有后端服务均属于 GLOBAL 范围。CN 栈使用相同的 Docker 镜像，但以 `KITORA_REGION=CN` 启动，并连接一套完全独立的阿里云侧后端服务（参见 `docs/deploy/cn.md`）。两个区域之间没有任何数据流动 —— 代码库在设计上是共享无状态的（RFC 0005 §2）。

## 前置条件

- Postgres 15+ 数据库，建议搭配连接池。将连接池 URL 设置为 `DATABASE_URL`，将直连 URL 设置为 `DIRECT_URL`（Prisma 执行迁移时使用直连）。
- Redis（Upstash REST 或自托管）。设置 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN`。
- S3 存储桶，推荐区域 `us-east-1`。设置 `DATA_EXPORT_S3_BUCKET`、`DATA_EXPORT_S3_REGION`、`DATA_EXPORT_S3_ACCESS_KEY_ID`、`DATA_EXPORT_S3_SECRET_ACCESS_KEY`。将 `DATA_EXPORT_STORAGE=s3` 切换存储层，不再使用本地文件系统。
- Stripe 账户（生产模式）。设置 `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`STRIPE_PRO_PRICE_ID`、`STRIPE_TEAM_PRICE_ID`。
- Resend 账户及已验证的发件人域名。设置 `RESEND_API_KEY` 和 `EMAIL_FROM`。
- `AUTH_SECRET` —— 用 `openssl rand -base64 32` 生成。轮换时需同步递增 `User.sessionVersion`（RFC 0002 PR-1），确保已有 JWT 同步失效。
- Sentry 项目（可选）。设置 `NEXT_PUBLIC_SENTRY_DSN`、`SENTRY_AUTH_TOKEN`、`SENTRY_ORG`、`SENTRY_PROJECT` 以在 CI 中上传 Source Map。

## 区域配置

本 RFC 最重要的一个环境变量：

```env
KITORA_REGION=GLOBAL
```

需在以下位置同时设置：

- Docker 镜像构建时（`--build-arg KITORA_REGION=GLOBAL`，在构建阶段烘焙进镜像，避免运行时偏差）；
- 运行时环境（Vercel 项目环境变量、Fly secret、k8s configmap —— 视平台而定）；
- CI 部署流水线（确保预发和生产保持一致）。

任何地方读取区域信息都应通过 `src/lib/region.ts` 中的 `currentRegion()`，而非直接访问 `process.env.KITORA_REGION`。`src/middleware.ts` 中的中间件垫片是唯一例外（edge runtime 无法导入仅限 Node 的工具函数）。

`src/instrumentation.ts` 中的启动钩子会调用 `assertRegionMatchesDatabase()` —— 如果数据库中存在任何 `Organization` 行的区域与环境变量不匹配，进程会以退出码 1 终止，而不是悄悄将数据写入错误的数据驻留区。如果部署后服务无法启动，请关注日志中的 `region-startup-mismatch`。

## 首次上线流程

1. 对生产数据库执行 Prisma 迁移：
   ```sh
   pnpm prisma migrate deploy
   ```
   `20260427000000_add_region_columns` 迁移会将所有 RFC 0005 之前的行回填为 `region = GLOBAL`。这对现有的 kitora.io 数据是正确的 —— 历史上不存在需要区别标记的 CN/EU 数据。
2. 构建并推送带有 `KITORA_REGION=GLOBAL` 烘焙值的镜像：
   ```sh
   docker build --build-arg KITORA_REGION=GLOBAL -t kitora:global .
   ```
3. 上线部署。应用启动后会触发启动区域检查，日志输出 `region-startup-check-ok`，随后开始正常服务。

## 部署后健康检查

- `curl https://kitora.io/api/health` 返回 200。
- 随机抽取一行 `Organization`，确认数据库中 `region = 'GLOBAL'`。
- 注册一个全新测试账户，确认 `User.region` 和新建的 `Organization.region` 均为 `GLOBAL`（用相同邮箱重试注册时，`(email, region)` 复合唯一约束会触发）。
- 该次注册产生的 `audit_log` 写入记录携带 `region = 'GLOBAL'` —— 可用以下语句验证：`select region, count(*) from "AuditLog" group by region;`。
- 出站邮件和 Stripe 结账端到端可用（`src/lib/region/providers.ts` 中的 provider 工厂会解析为 Resend / S3 / Stripe）。

## 后台任务定时调度（RFC 0008）

`BackgroundJob` 表通过每个栈一个 cron 条目驱动。

**Vercel**（GLOBAL 的推荐方式）：

1. `vercel.json` 已声明
   `{ "crons": [{ "path": "/api/jobs/tick", "schedule": "* * * * *" }] }`。
   Vercel 在部署时会自动识别该配置。
2. 在 Vercel 项目环境变量（Settings → Environment Variables）中将 `CRON_SECRET` 设置为一个 32 位以上的随机字符串：

   ```sh
   openssl rand -base64 32
   ```

   Vercel 会在每次 cron 请求中自动注入 `Authorization: Bearer …` 头；路由对其他来源的请求一律返回 401（探针、外部流量等）。若未设置 `CRON_SECRET`，路由会直接返回 503 `cron-not-configured`，cron 静默空转而不执行任何扫描 —— 这也是开发/预览环境的默认行为。

3. **套餐说明**：`/api/jobs/tick` 声明了 `maxDuration = 60`。Hobby 套餐上限为 10 秒 —— 生产环境应使用 Pro 套餐以获得足够余量。如果必须在 Hobby 套餐上运行（演示/预览），可在路由层传入更严格的预算：

   ```ts
   // src/app/api/jobs/tick/route.ts —— 仅在 Hobby 套餐时覆盖
   await runWorkerTick(workerId, { budgetMs: 8_000, batchSize: 1 });
   ```

**自托管替代方案**：`pnpm tsx scripts/run-jobs.ts` 是一个 CLI 入口，效果完全相同 —— 任何外部 cron（cron、systemd timer、GitHub Actions schedule 等）均可调用。旧版 `run-webhook-cron.ts` / `run-export-jobs.ts` / `run-deletion-cron.ts` 兼容垫片仍然保留，并已内部对接至同一库，现有部署可按自己的节奏迁移。

`BackgroundJob` 表同时存放定时任务和临时任务行。管理后台 `/admin/jobs` 展示各类型统计、最近记录，以及带有手动重试/取消按钮的 DEAD_LETTER 标签页。

## 回滚

RFC 0005 的 schema 迁移是纯增量的。如需回滚：

```sh
pnpm prisma migrate resolve --rolled-back 20260427000000_add_region_columns
```

然后根据迁移 SQL 手动删除该迁移新增的列和索引（详见迁移文件中的完整列表）。旧版二进制中引用 `region` 的应用代码会回退到列的默认值（`GLOBAL`），因此滚动发布时前进和回退不会造成数据丢失。
