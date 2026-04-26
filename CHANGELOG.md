# Changelog

本文档遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。每个 minor 版本对应一个 RFC 的落地，详细背景见 `docs/rfcs/`。

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

[0.6.0]: https://github.com/your-org/kitora/releases/tag/v0.6.0
[0.5.0]: https://github.com/your-org/kitora/releases/tag/v0.5.0
[0.4.0]: https://github.com/your-org/kitora/releases/tag/v0.4.0
[0.3.0]: https://github.com/your-org/kitora/releases/tag/v0.3.0
[0.2.0]: https://github.com/your-org/kitora/releases/tag/v0.2.0
[0.1.0]: https://github.com/your-org/kitora/releases/tag/v0.1.0
