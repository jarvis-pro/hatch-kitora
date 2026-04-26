import { prisma } from './fixtures/db';
import { expect, test } from './fixtures/test';

/**
 * RFC 0002 PR-1 — Active Sessions e2e.
 *
 * Two browser contexts == two independent JWT cookies == two DeviceSession
 * rows. We sign in twice, assert the list shows two rows, revoke the "other"
 * one from the first context, and verify the second context is hard-logged
 * out on the next request (jwt() callback returns null).
 */
test.describe('active sessions', () => {
  test('two devices appear, revoking one logs that device out', async ({
    browser,
    testUser,
    signIn,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await signIn(pageA, testUser);
      await signIn(pageB, testUser);

      // Both contexts wrote a DeviceSession row.
      const rows = await prisma.deviceSession.findMany({
        where: { userId: testUser.id, revokedAt: null },
      });
      expect(rows.length).toBe(2);

      // Page A: settings → see the two sessions, revoke the other one.
      await pageA.goto('/settings');
      // The "Sign out everywhere" button is unique to the sessions card —
      // its presence proves the card rendered. (CardTitle is a <div>, not
      // a heading, so we don't use getByRole('heading') here.)
      await expect(pageA.getByRole('button', { name: /sign out everywhere/i })).toBeVisible();
      // Current device shows "Current device" badge; the other one is the
      // only row with a Revoke button.
      const revokeButton = pageA.getByRole('button', { name: /^revoke$/i });
      await expect(revokeButton).toBeVisible();

      // Need to dismiss the native confirm dialog the revoke button triggers.
      pageA.once('dialog', (d) => d.accept());
      await revokeButton.click();

      // Settle: the action revalidates /settings and the row should drop.
      await pageA.waitForLoadState('networkidle');

      // Page B: any protected request now hits jwt() callback → null →
      // middleware redirects to /login.
      await pageB.goto('/dashboard');
      await pageB.waitForURL(/\/login/);
      expect(pageB.url()).toMatch(/\/login/);

      // Confirm the DB state matches: exactly one unrevoked row left.
      const after = await prisma.deviceSession.findMany({
        where: { userId: testUser.id, revokedAt: null },
      });
      expect(after.length).toBe(1);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('sign out everywhere revokes every device session row', async ({
    browser,
    testUser,
    signIn,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await signIn(pageA, testUser);
      await signIn(pageB, testUser);

      await pageA.goto('/settings');
      pageA.once('dialog', (d) => d.accept());
      await pageA.getByRole('button', { name: /sign out everywhere/i }).click();

      // Action ends with signOut → redirect to /login.
      await pageA.waitForURL(/\/login/);

      // Both rows are revoked; B is locked out next request.
      const after = await prisma.deviceSession.findMany({
        where: { userId: testUser.id, revokedAt: null },
      });
      expect(after.length).toBe(0);

      await pageB.goto('/dashboard');
      await pageB.waitForURL(/\/login/);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
