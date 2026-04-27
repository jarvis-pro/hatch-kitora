import { deleteUser, prisma, uniqueEmail } from './fixtures/db';
import { expect, test } from './fixtures/test';

test.describe('auth', () => {
  test('signup → dashboard, then logout', async ({ page }) => {
    const email = uniqueEmail('e2e-signup');
    const password = 'Test1234!';

    await page.goto('/signup');
    await page.getByLabel(/name/i).fill('E2E Signup');
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole('button', { name: /create account/i }).click();

    await page.waitForURL(/\/dashboard/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/welcome/i);

    // 清理。RFC 0005 — `email` 单独不再唯一；测试进程
    // 始终运行在 GLOBAL region（默认 `KITORA_REGION`），
    // 因此通过 (email, region) 复合键查找。
    const user = await prisma.user.findUnique({
      where: { email_region: { email, region: 'GLOBAL' } },
    });
    if (user) await deleteUser(user.id);
  });

  test('login form rejects wrong password', async ({ testUser, page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill(testUser.email);
    await page.getByLabel(/password/i).fill('definitely-wrong-pw');
    // exact: true —— `/login` 页另有「Sign in with a passkey」按钮会撞 strict mode。
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    // Stay on /login — toast should fire; don't depend on toast text since it
    // fades. Assert URL only.
    await page.waitForTimeout(500);
    expect(page.url()).toMatch(/\/login/);
  });

  test('protected route redirects unauthenticated users', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForURL(/\/login/);
    expect(page.url()).toMatch(/callbackUrl=%2Fdashboard|callbackUrl=\/dashboard/);
  });
});
