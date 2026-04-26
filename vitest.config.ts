// RFC 0008 PR-1 — Vitest 单测配置。
//
// 引入背景：背景 jobs 抽象层（src/lib/jobs/*）需要对纯函数（指数退避边界、
// payload zod 校验、registry 重复注册行为、enqueue P2002 swallow）做亚秒级
// 单测；项目此前只有 Playwright e2e（全量真 PG + Next.js 启动），跑一个 case
// ≥ 5s，不适合 lib 级别的密集断言。需要真 PG 的 SKIP LOCKED claim / 崩溃恢复
// 路径仍走 e2e（PR-5 在 tests/e2e/ 下与现有 21 个 spec 同结构）。
//
// 选 Vitest 而非 Jest 的理由：
//   - 原生 ESM + TS 零 Babel/ts-jest 配置，与 Next.js 14 / TypeScript 5.7 直接兼容；
//   - vite 解析速度快，watch 模式秒级反馈；
//   - API 与 Jest 99% 兼容，未来若要切回 jest 成本极低。
//
// path alias `@/*` 与 tsconfig.json 保持一致；test 环境 = node（lib 全是
// server-side，不挂 jsdom 省启动时间）。

import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // 仅扫 src/ 下的 .test.ts；e2e 在 tests/e2e/ 走 Playwright，不应被 vitest 收录。
    include: ['src/**/*.test.ts'],
    // 显式 import { describe, it, expect }，不污染全局 — 与项目 ESM-first 风格一致。
    globals: false,
    // 默认 forks pool 隔离每个 test file，方便清理 module-level singleton（如 JobRegistry）。
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
