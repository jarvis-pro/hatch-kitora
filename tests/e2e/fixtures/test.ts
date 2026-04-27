import { test as base, expect, type Page } from '@playwright/test';

import { createTestUser, deleteUser, type CreateTestUserOptions, type TestUser } from './db';

interface Fixtures {
  /** A fresh user per test, automatically cleaned up afterwards. */
  testUser: TestUser;
  /** Same as testUser but with role=ADMIN. */
  adminUser: TestUser;
  /** Helper that signs the given user in via the public /login form. */
  signIn: (page: Page, user: TestUser) => Promise<void>;
}

export const test = base.extend<Fixtures>({
  testUser: async ({}, use) => {
    const created = await createTestUser({ emailVerified: true });
    try {
      await use(created);
    } finally {
      await deleteUser(created.id);
    }
  },
  adminUser: async ({}, use) => {
    const created = await createTestUser({ role: 'ADMIN', emailVerified: true });
    try {
      await use(created);
    } finally {
      await deleteUser(created.id);
    }
  },
  signIn: async ({}, use) => {
    await use(async (page, user) => {
      await page.goto('/login');
      await page.getByLabel(/email/i).fill(user.email);
      await page.getByLabel(/password/i).fill(user.rawPassword);
      // `exact: true` 是必要的 —— `/login` 页同时挂着「Sign in」(password 提交)
      // 与「Sign in with a passkey」(WebAuthn) 两个按钮，用 `/sign in/i` 会
      // 撞 strict mode violation。`exact` 把 accessible name 锁死成纯 "Sign in"。
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL(/\/dashboard/);
    });
  },
});

export { expect };

/** Convenience for tests that want a one-off user without the lifecycle hook. */
export async function createDisposableUser(opts?: CreateTestUserOptions): Promise<TestUser> {
  return createTestUser(opts);
}
