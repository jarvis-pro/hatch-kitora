import bcrypt from 'bcryptjs';

import { prisma } from './fixtures/db';
import { expect, test } from './fixtures/test';

test.describe('change password', () => {
  test('wrong current password is rejected', async ({ testUser, page, signIn }) => {
    await signIn(page, testUser);
    await page.goto('/settings');

    await page.getByLabel(/^current password$/i).fill('not-the-current-pw');
    await page.getByLabel(/^new password$/i).fill('Brandnew1!');
    await page.getByLabel(/confirm new password/i).fill('Brandnew1!');
    await page.getByRole('button', { name: /update password/i }).click();

    // Server returns wrong-password → toast fires; user stays on /settings.
    await page.waitForTimeout(500);
    expect(page.url()).toMatch(/\/settings/);

    // DB hash unchanged.
    const fresh = await prisma.user.findUnique({ where: { id: testUser.id } });
    expect(await bcrypt.compare(testUser.rawPassword, fresh!.passwordHash!)).toBe(true);
  });

  test('successful change signs the user out and bumps sessionVersion', async ({
    testUser,
    page,
    signIn,
  }) => {
    await signIn(page, testUser);
    await page.goto('/settings');

    await page.getByLabel(/^current password$/i).fill(testUser.rawPassword);
    await page.getByLabel(/^new password$/i).fill('Brandnew1!');
    await page.getByLabel(/confirm new password/i).fill('Brandnew1!');
    await page.getByRole('button', { name: /update password/i }).click();

    // Action calls signOut → /login.
    await page.waitForURL(/\/login/);

    const fresh = await prisma.user.findUnique({ where: { id: testUser.id } });
    expect(fresh?.sessionVersion).toBeGreaterThan(0);
    expect(await bcrypt.compare('Brandnew1!', fresh!.passwordHash!)).toBe(true);
  });
});
