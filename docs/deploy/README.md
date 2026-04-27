# Deploy

Kitora 按 **region**（数据驻留区）独立部署，每个区域是一套完全 share-nothing 的栈。本目录每个文件描述**一个区域**的部署蓝图。

设计依据：[RFC 0005 — 数据驻留](../rfcs/0005-data-residency.md)。

## 区域速查

| 区域   | 文档                     | 域名      | 状态                                    | 主要供应商                                              | 关联 RFC                                                   |
| ------ | ------------------------ | --------- | --------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| GLOBAL | [global.md](./global.md) | kitora.io | **生产运维**                            | Vercel / Cloud Run · Stripe · Resend · S3/R2            | RFC 0005                                                   |
| CN     | [cn.md](./cn.md)         | kitora.cn | **存根**（待 ICP 备案 + RFC 0006 落地） | 阿里云 ACK · 支付宝 / 微信支付 · DirectMail · OSS · SLS | RFC 0005, [RFC 0006](../rfcs/0006-cn-region-deployment.md) |
| EU     | [eu.md](./eu.md)         | kitora.eu | **占位符**（无客户需求前不激活）        | 同 GLOBAL，使用 EU 区域端点                             | RFC 0005                                                   |

## 环境变量约定

`KITORA_REGION` 是每个进程的**生命期常量**，合法值 `GLOBAL` / `CN` / `EU`。读取入口**只能**是 `currentRegion()`（`src/lib/region.ts`），禁止直接 `process.env.KITORA_REGION`——理由见 [vue-to-nextjs §4.1](../getting-started/vue-to-nextjs.md)。

## 写新区域文档时必须包含的章节

为方便读者横向对照，每份区域部署文档保留以下章节顺序：

1. **状态** — 生产运维 / 存根 / 占位符（写在文档开头的引用块里）
2. **拓扑结构** — ASCII 图，覆盖入口、Web、DB、缓存、对象存储、邮件、监控
3. **关键环境变量** — 至少包含 `KITORA_REGION`、`DATABASE_URL`、`AUTH_*`、Provider 凭证
4. **部署步骤** — 从零到生产可重复跑通的命令清单
5. **后台任务定时调度** — 如何驱动 `/api/jobs/tick`（Vercel Cron / 阿里云定时触发器 / k8s CronJob 等）
6. **监控与日志** — Sentry DSN、日志聚合点、告警通道
7. **法规合规** — 该区域特有的合规要求（如 CN 的 ICP / 公安备案）

## 本地起多区域开发栈

```bash
# GLOBAL 默认栈
docker compose up

# CN 模拟栈（独立卷）
docker compose -f docker-compose.cn.yml up

# EU 模拟栈（独立卷）
docker compose -f docker-compose.eu.yml up
```

切换前请清空对应的 Postgres 卷，避免 region 列与运行时不一致。

## 上下游

- 想知道**为什么**这样切区域 → [RFC 0005](../rfcs/0005-data-residency.md)
- 中国区**特定的**运维细节 → [RFC 0006](../rfcs/0006-cn-region-deployment.md)
- 中间件 / 数据库一层的实现 → `src/lib/region.ts`、`src/lib/region/providers.ts`
