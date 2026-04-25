import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * Playwright config — runs against a real Next.js dev/prod server pointed at
 * a real (test) Postgres instance. Email and Stripe calls are mocked or
 * driven directly via DB writes (see `tests/e2e/fixtures`).
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false, // tests share a DB; serialise to keep them deterministic
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
        // `next start` needs a prior `next build`. CI runs build, then this.
        // Locally you can `pnpm dev` in another shell and set E2E_NO_SERVER=1.
        command: `pnpm start --port ${PORT}`,
        url: `${BASE_URL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          // `next start` runs as NODE_ENV=production where Auth.js defaults
          // `useSecureCookies: true`. Over plain HTTP that drops the session
          // cookie and breaks every authenticated test. AUTH_URL's protocol
          // toggles the flag; AUTH_TRUST_HOST is required since we're not on
          // Vercel.
          AUTH_URL: BASE_URL,
          AUTH_TRUST_HOST: 'true',
        },
      },
});
