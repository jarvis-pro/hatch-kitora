import { expect, test } from './fixtures/test';

test.describe('admin gating', () => {
  test('non-admin gets redirected away from /admin', async ({ testUser, page, signIn }) => {
    await signIn(page, testUser);
    await page.goto('/admin');
    await page.waitForURL(/\/dashboard/);
    expect(page.url()).toMatch(/\/dashboard/);
  });

  test('admin sees the overview page', async ({ adminUser, page, signIn }) => {
    await signIn(page, adminUser);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/admin/i);
    // Sidebar nav surfaces the three admin sections.
    await expect(page.getByRole('link', { name: /users/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /subscriptions/i })).toBeVisible();
  });
});
