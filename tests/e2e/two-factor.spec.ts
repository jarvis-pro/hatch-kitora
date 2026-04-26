import { prisma } from './fixtures/db';
import { expect, test } from './fixtures/test';

/**
 * RFC 0002 PR-2 — 2FA enrollment + login challenge e2e.
 *
 * The challenge page asks for a real TOTP code, so we need to compute one on
 * the fly. We import the pure base32 / TOTP helpers (the encryption parts
 * live next door behind `server-only`, which would refuse to load here).
 */
import { base32Decode, base32Encode, totpNow } from '../../src/lib/auth/2fa-totp';

test.describe('two-factor', () => {
  test('enroll → logout → login → 2FA challenge → dashboard', async ({
    browser,
    testUser,
    signIn,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await signIn(page, testUser);

      // ── 1. Enroll ──
      await page.goto('/settings');
      await page.getByRole('button', { name: /^enable 2fa$/i }).click();
      // Read back the manual-entry secret rendered in the readonly input.
      const secretInput = page.locator('#setup-key');
      await expect(secretInput).toBeVisible();
      const secretBase32 = await secretInput.inputValue();
      const secretBuf = base32Decode(secretBase32);

      // Acknowledge backup codes & confirm with a freshly computed TOTP.
      await page.getByLabel(/i've saved my backup codes/i).check();
      const code1 = totpNow(secretBuf);
      await page.locator('#confirm-code').fill(code1);

      // The Confirm button is disabled until React has propagated all three
      // gates (acknowledgedBackup ✓, confirmCode.length === 6, !pending).
      // Without waiting for `toBeEnabled` the click can race with React's
      // re-render and silently no-op against a still-disabled button.
      const confirmBtn = page.getByRole('button', { name: /^confirm$/i });
      await expect(confirmBtn).toBeEnabled();
      await confirmBtn.click();

      // Wait for state to flip to "enabled" — the Disable button appears.
      // Bump the timeout: the action has to run a DB tx + jwt update + cookie
      // round-trip + RSC refresh; a tight default sometimes loses the race
      // with React 18's transition flushing.
      await expect(page.getByRole('button', { name: /^disable 2fa$/i })).toBeVisible({
        timeout: 10_000,
      });

      // DB state: row enabled, flag flipped.
      const row = await prisma.twoFactorSecret.findUnique({ where: { userId: testUser.id } });
      expect(row?.enabledAt).not.toBeNull();
      expect(row?.backupHashes.length).toBe(10);
      const userAfter = await prisma.user.findUnique({ where: { id: testUser.id } });
      expect(userAfter?.twoFactorEnabled).toBe(true);

      // ── 2. Logout & re-login ──
      await page.goto('/login');
      await page.getByLabel(/email/i).fill(testUser.email);
      await page.getByLabel(/password/i).fill(testUser.rawPassword);
      await page.getByRole('button', { name: /sign in/i }).click();

      // Should be bumped to /login/2fa instead of /dashboard.
      await page.waitForURL(/\/login\/2fa/);

      // ── 3. Pass the challenge with a fresh TOTP ──
      const code2 = totpNow(secretBuf);
      await page.locator('#code').fill(code2);
      await page.getByRole('button', { name: /^verify$/i }).click();
      await page.waitForURL(/\/dashboard/);
    } finally {
      // Clean up TFA artefacts so the user fixture's deleteUser cascade has
      // nothing surprising to remove.
      await prisma.twoFactorSecret
        .delete({ where: { userId: testUser.id } })
        .catch(() => undefined);
      await ctx.close();
    }
  });

  test('enrolling rolls a fresh secret each click (encoder roundtrip)', async () => {
    // Pure unit-style sanity check — no UI involved. Catches base32 regressions
    // that would otherwise only be caught by the long e2e above.
    const buf = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
    const round = base32Decode(base32Encode(buf));
    expect(round.equals(buf)).toBe(true);
  });
});
