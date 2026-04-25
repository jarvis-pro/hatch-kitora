import bcrypt from 'bcryptjs';

import { issuePasswordResetToken, prisma } from './fixtures/db';
import { expect, test } from './fixtures/test';

test.describe('password reset', () => {
  test('valid token → new password works', async ({ testUser, page }) => {
    const raw = await issuePasswordResetToken(testUser.id);

    await page.goto(`/reset-password?token=${raw}`);
    await page.getByLabel(/^new password/i).fill('Brandnew1!');
    await page.getByLabel(/confirm password/i).fill('Brandnew1!');
    await page.getByRole('button', { name: /update password/i }).click();

    // Server action signs the user out and redirects to /login.
    await page.waitForURL(/\/login/);

    // Persisted hash should now match the new password.
    const fresh = await prisma.user.findUnique({ where: { id: testUser.id } });
    expect(fresh?.passwordHash).toBeTruthy();
    expect(await bcrypt.compare('Brandnew1!', fresh!.passwordHash!)).toBe(true);
  });

  test('missing token shows the recovery prompt', async ({ page }) => {
    await page.goto('/reset-password');
    await expect(page.getByRole('heading')).toContainText(/reset link missing/i);
  });
});
