import { prisma } from './fixtures/db';
import { expect, test } from './fixtures/test';

test.describe('settings — profile', () => {
  test('update display name', async ({ testUser, page, signIn }) => {
    await signIn(page, testUser);
    await page.goto('/settings');

    const next = `Updated ${Date.now()}`;
    await page.getByLabel(/^name$/i).fill(next);
    await page.getByRole('button', { name: /save changes/i }).click();

    // Toast fires + DB row updates.
    await page.waitForTimeout(500);
    const fresh = await prisma.user.findUnique({ where: { id: testUser.id } });
    expect(fresh?.name).toBe(next);
  });
});
