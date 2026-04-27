# 部署 — EU 区域 (kitora.eu)

> **状态**: 占位符。EU 数据驻留列在"有则最好"的计划轨道上（RFC 0005 §1）—— 待有付费企业客户提出需求后再从占位符升级为正式部署。在此之前，本文档的主要作用是确保代码库不会偏离 EU 可上线的状态。

EU 栈将与 GLOBAL 和 CN 完全隔离：独立的数据库、独立的对象存储、独立的认证域名。区域语义与 GLOBAL 一致：相同的 Stripe / Resend / S3 provider（使用 EU 区域端点），相同的代码路径。

## 当前已就绪内容

- `Region.EU` 是 Prisma 枚举中的合法值（`prisma/schema.prisma`），也是 `KITORA_REGION` 的合法取值（`src/env.ts`）。
- provider 工厂（`src/lib/region/providers.ts`）目前将 EU 视为 GLOBAL 的别名（Stripe / Resend / 默认存储）。EU 正式上线时，可选择保持现状（运维成本更低）或换用 EU 区域专属端点/密钥。
- `docker-compose.eu.yml` 为本地开发启动一组独立卷的 Postgres + Redis。

## 后台任务定时调度（RFC 0008）

EU 正式上线后，照搬 `docs/deploy/global.md` 中的 `## 后台任务定时调度` 方案（Vercel + `CRON_SECRET` + `/api/jobs/tick`）即可 —— EU 栈与 GLOBAL 使用相同的 Vercel + Resend 拓扑，Vercel Cron 是合适的入口。预计无需任何 EU 专属的 cron 基础设施。

## 正式上线时的步骤

- 注册 `kitora.eu`（任意 ICANN 认证注册商；无需特殊备案，与 CN 不同）。
- 选择后端服务所在的 EU 区域：`eu-west-1`（爱尔兰）是惯用选择；若客户的 GDPR 合规要求德国境内存储，可选 `eu-central-1`（法兰克福）。
- 以 `--build-arg KITORA_REGION=EU` 构建镜像，与 GLOBAL 并列部署。
- 更新本文档及 `docs/deploy/global.md`，补充实际拓扑信息。
