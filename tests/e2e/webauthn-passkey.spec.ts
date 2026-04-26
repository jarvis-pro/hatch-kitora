import type { CDPSession, Page } from '@playwright/test';

import { prisma } from './fixtures/db';
import { expect, test } from './fixtures/test';

/**
 * RFC 0007 PR-5 — Passkey e2e.
 *
 * WebAuthn ceremonies need a real authenticator. We can't ship a hardware
 * key into CI, so we use Chrome DevTools Protocol's `WebAuthn` domain to
 * attach a *virtual* authenticator: the CDP layer signs registration /
 * authentication challenges entirely in-process, with no native UI.
 *
 *   1. `WebAuthn.enable` on a CDPSession bound to the page.
 *   2. `WebAuthn.addVirtualAuthenticator` — choose `internal` transport
 *      and `ctap2` protocol so the resulting credential reports
 *      `deviceType = singleDevice` (not "synced"); deterministic for
 *      assertions.
 *   3. From here `navigator.credentials.create / get` Just Works™ and our
 *      SimpleWebAuthn-driven flow signs / verifies normally.
 *
 * RFC §6 calls for 5 cases:
 *   - register a passkey from /settings/security/passkeys
 *   - the freshly-registered passkey shows up in the list
 *   - delete a passkey via the row's Remove control
 *   - login: `2FA` page accepts a passkey for an enrolled user
 *   - login: `/login` page accepts a passkey via the passwordless button
 *
 * Each scenario builds its own user + virtual authenticator, so they're
 * independent. The whole spec is in one file so the CDP boilerplate is
 * declared once.
 */

interface VirtualAuthenticator {
  cdp: CDPSession;
  authenticatorId: string;
}

async function attachVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const result = (await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })) as { authenticatorId: string };
  return { cdp, authenticatorId: result.authenticatorId };
}

async function detachVirtualAuthenticator({ cdp, authenticatorId }: VirtualAuthenticator) {
  try {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  } catch {
    // Already torn down with the page — fine.
  }
  try {
    await cdp.detach();
  } catch {
    /* noop */
  }
}

test.describe('webauthn / passkey', () => {
  test('register → list → remove from /settings/security/passkeys', async ({
    browser,
    testUser,
    signIn,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const auth = await attachVirtualAuthenticator(page);
    try {
      await signIn(page, testUser);
      await page.goto('/settings/security/passkeys');

      // Register: open the form, name it, confirm.
      await page.getByRole('button', { name: /add a passkey|添加 passkey/i }).click();
      await page.getByLabel(/name|名称/i).fill('e2e-virtual-key');
      await page.getByRole('button', { name: /^confirm$|^确认$/i }).click();

      // The list re-renders with the new credential.
      await expect(page.getByText('e2e-virtual-key')).toBeVisible({ timeout: 10_000 });

      // DB sanity: one credential row attached to this user.
      const after = await prisma.webAuthnCredential.findMany({
        where: { userId: testUser.id },
        select: { id: true, name: true },
      });
      expect(after).toHaveLength(1);
      expect(after[0]!.name).toBe('e2e-virtual-key');

      // Removing the last passkey hits the "last passkey" confirm path —
      // accept the native confirm() dialog before clicking.
      page.once('dialog', (d) => d.accept());
      await page
        .getByRole('button', { name: /^remove$|^移除$/i })
        .first()
        .click();

      await expect(page.getByText(/no passkeys added yet|还没有添加 passkey/i)).toBeVisible({
        timeout: 10_000,
      });
      const cleared = await prisma.webAuthnCredential.count({ where: { userId: testUser.id } });
      expect(cleared).toBe(0);
    } finally {
      await detachVirtualAuthenticator(auth);
      await ctx.close();
    }
  });

  test('passwordless: register on settings, sign in via /login passkey button', async ({
    browser,
    testUser,
    signIn,
  }) => {
    // ── Phase 1: register the passkey while signed in ──
    const enrollCtx = await browser.newContext();
    const enrollPage = await enrollCtx.newPage();
    const enrollAuth = await attachVirtualAuthenticator(enrollPage);
    try {
      await signIn(enrollPage, testUser);
      await enrollPage.goto('/settings/security/passkeys');
      await enrollPage.getByRole('button', { name: /add a passkey|添加 passkey/i }).click();
      await enrollPage.getByLabel(/name|名称/i).fill('e2e-passwordless');
      await enrollPage.getByRole('button', { name: /^confirm$|^确认$/i }).click();
      await expect(enrollPage.getByText('e2e-passwordless')).toBeVisible({ timeout: 10_000 });
    } finally {
      await detachVirtualAuthenticator(enrollAuth);
      await enrollCtx.close();
    }

    // The persisted credential survives the new context — that's the
    // whole point of "discoverable credentials" living server-side.
    const stored = await prisma.webAuthnCredential.findMany({
      where: { userId: testUser.id },
      select: { id: true, credentialId: true },
    });
    expect(stored).toHaveLength(1);

    // ── Phase 2: brand-new context, brand-new authenticator preloaded
    // with the same credential, click "Sign in with a passkey". ──
    // (Fresh context = no cookie, simulating a logged-out browser.)
    //
    // CDP's virtual authenticator is per-page. We can't transplant the
    // private key from Phase 1, so the cleanest passwordless smoke is to
    // delete the stale credential, register a new one for the same user,
    // and *then* test the passwordless flow with that key live.
    //
    // Phase 2 below does exactly that: log in normally, register again,
    // log out, then drive the passkey button while the same authenticator
    // is still attached.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const auth = await attachVirtualAuthenticator(page);
    try {
      // Re-enrol fresh so the active virtual authenticator owns the key.
      await signIn(page, testUser);
      await page.goto('/settings/security/passkeys');
      await page.getByRole('button', { name: /add a passkey|添加 passkey/i }).click();
      await page.getByLabel(/name|名称/i).fill('e2e-passwordless-2');
      await page.getByRole('button', { name: /^confirm$|^确认$/i }).click();
      await expect(page.getByText('e2e-passwordless-2')).toBeVisible({ timeout: 10_000 });

      // Sign out — clear the session cookie via Auth.js's POST endpoint.
      await page.request.post('/api/auth/signout', {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        data: 'callbackUrl=/login',
      });
      await ctx.clearCookies();

      // Now the passwordless click — reach the dashboard without a
      // password ever being typed.
      await page.goto('/login');
      await page.getByRole('button', { name: /sign in with a passkey|用 passkey 登录/i }).click();
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

      // The credential row's lastUsedAt should now be populated.
      const creds = await prisma.webAuthnCredential.findMany({
        where: { userId: testUser.id, name: 'e2e-passwordless-2' },
      });
      expect(creds[0]?.lastUsedAt).not.toBeNull();
    } finally {
      await detachVirtualAuthenticator(auth);
      await ctx.close();
    }
  });
});
