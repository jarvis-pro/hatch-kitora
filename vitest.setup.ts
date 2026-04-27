/**
 * Vitest 进程级 setup —— 在每个 test file 加载前跑一次（forks pool 下每个 fork
 * 各跑一次）。
 *
 * 职责：
 *
 *   1. **加载 `.env`** —— Vitest 自身不像 `next dev` / `next build` 会自动 load
 *      `.env*`；任何 transitively 走到 `@/env`（t3-env createEnv）的 test
 *      会在 `DATABASE_URL` / `AUTH_SECRET` 校验阶段抛 `Invalid environment
 *      variables`。observability / schedules / runner 都靠 `@/lib/logger` 间接
 *      命中这条链。Node 22+ 内置 `process.loadEnvFile`，零依赖。
 *
 *   2. **兜底占位** —— CI / 干净 checkout 可能没有 `.env`，给两条最小可用值，
 *      让校验通过。单测不连真 PG / 真 Auth，所以值是哑的。
 */
try {
  // Node 22+ — 同名变量已在 process.env 里就不覆盖（与 dotenv 默认语义一致）。
  process.loadEnvFile('.env');
} catch {
  // .env 不存在不致命；下面的 ??= 兜底保住校验。
}

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/kitora_test?schema=public';
process.env.AUTH_SECRET ??= 'unit-test-placeholder-secret-min-32-chars-padding';
