import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * Playwright 配置 —— 对接真实的 Next.js dev/prod 服务器，
 * 连接真实的（测试用）Postgres 实例。邮件和 Stripe 调用通过 mock
 * 或直接写 DB 的方式驱动（见 `tests/e2e/fixtures`）。
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false, // 多个 test 共享同一个 DB，串行执行保证确定性
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        // `next start` 需要先执行 `next build`。CI 先跑 build，再跑此配置。
        // 本地可以在另一个终端 `pnpm dev`，再设置 E2E_NO_SERVER=1。
        command: `pnpm start --port ${PORT}`,
        url: `${BASE_URL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          // `next start` 以 NODE_ENV=production 运行，Auth.js 在此模式下
          // 默认 `useSecureCookies: true`。在纯 HTTP 下 session cookie 会
          // 被丢弃，导致所有需要认证的测试失败。AUTH_URL 的协议头控制该标志；
          // 非 Vercel 环境下还需要 AUTH_TRUST_HOST。
          AUTH_URL: BASE_URL,
          AUTH_TRUST_HOST: 'true',
          // 在任何框架模块加载之前预加载 stderr 过滤器 ——
          // 在 `instrumentation.ts` 里打补丁太晚了，因为 Next.js 在自身
          // 模块初始化时就已经接管了 `process.stderr.write`。
          NODE_OPTIONS: '-r ./scripts/silence-auth-noise.cjs',
        },
      },
});
