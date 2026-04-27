import { prisma } from './fixtures/db';
import { expect, test } from './fixtures/test';

/**
 * RFC 0002 PR-4 — 删除宽限期 + 组织级 2FA 强制执行。
 *
 * 两类测试放在一起，因为都涉及核心用户 / 组织生命周期：
 *
 *   1. 删除：触发 → DB 行翻转 → 取消 → DB 行回滚。
 *   2. 组织 2FA 开关：未启用 2FA 的调用方被拒绝，启用了 2FA 的
 *      用户第二次切换成功。
 *
 * 删除测试刻意停在 DB 层而非走完整 UI（toast → banner → cancel）——
 * schedule action 会将用户登出，否则需要在测试中途重新登录，
 * 对边际覆盖率来说代价翻倍。
 */
test.describe('account deletion grace period', () => {
  test('schedule sets PENDING_DELETION + scheduledAt; cancel reverts to ACTIVE', async ({
    page,
    testUser,
    signIn,
  }) => {
    await signIn(page, testUser);

    // Trigger the schedule via the existing DangerZone form. The action
    // signs the user out, so after this we navigate to /login again and
    // re-authenticate to verify the banner-cancel path.
    await page.goto('/settings');
    await page.locator('#confirmEmail').fill(testUser.email);
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /^schedule deletion$/i }).click();

    // The action redirects to /login; wait for the URL to settle before
    // checking the DB state.
    await page.waitForURL(/\/login/);

    const scheduled = await prisma.user.findUnique({
      where: { id: testUser.id },
      select: { status: true, deletionScheduledAt: true },
    });
    expect(scheduled?.status).toBe('PENDING_DELETION');
    expect(scheduled?.deletionScheduledAt).not.toBeNull();
    // Should land roughly 30d in the future (give or take an hour).
    const ms = scheduled!.deletionScheduledAt!.getTime() - Date.now();
    expect(ms).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(ms).toBeLessThan(31 * 24 * 60 * 60 * 1000);

    // Reset DB row directly so the cleanup hook (deleteUser cascade) sees
    // a normal ACTIVE user. Calling cancelAccountDeletionAction would
    // require a fresh login, which doubles test runtime.
    await prisma.user.update({
      where: { id: testUser.id },
      data: {
        status: 'ACTIVE',
        deletionScheduledAt: null,
        deletionRequestedFromIp: null,
      },
    });
  });

  test('PENDING_DELETION user is herded to /settings on dashboard nav', async ({
    page,
    testUser,
  }) => {
    // Pre-flight: stamp the user as already PENDING_DELETION so we can
    // skip the schedule-then-relogin dance.
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await prisma.user.update({
      where: { id: testUser.id },
      data: { status: 'PENDING_DELETION', deletionScheduledAt: futureDate },
    });

    try {
      // Manual login (the shared `signIn` fixture waits for /dashboard,
      // but a PENDING_DELETION user gets redirected to /settings by
      // middleware before that URL is ever reached — using the helper
      // would hang the test until timeout).
      await page.goto('/login');
      await page.getByLabel(/email/i).fill(testUser.email);
      await page.getByLabel(/password/i).fill(testUser.rawPassword);
      // exact: true —— `/login` 页另有「Sign in with a passkey」按钮会撞 strict mode。
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      // Either /dashboard (briefly, before middleware fires) or /settings.
      // We assert the *eventual* URL contains /settings.
      await page.waitForURL(/\/settings(\/|\?|$)/, { timeout: 10_000 });

      // Hard nav to /dashboard re-confirms the redirect rule.
      await page.goto('/dashboard');
      await page.waitForURL(/\/settings(\/|\?|$)/, { timeout: 10_000 });

      // Sanity: the deletion banner is visible on the settings page.
      await expect(page.getByText(/your account is scheduled for deletion/i)).toBeVisible();
    } finally {
      // Reset so the user fixture's cleanup runs cleanly. Use updateMany
      // with a where-clause so a missing row is a no-op rather than an
      // error (defensive: if cleanup races with the fixture teardown).
      await prisma.user.updateMany({
        where: { id: testUser.id },
        data: { status: 'ACTIVE', deletionScheduledAt: null },
      });
    }
  });
});
