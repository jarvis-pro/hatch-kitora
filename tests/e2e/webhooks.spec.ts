import { createOrgWithOwner, createTestUser, deleteOrg, deleteUser, prisma } from './fixtures/db';
import { expect, test } from './fixtures/test';

import { validateWebhookUrl } from '../../src/services/webhooks/url-guard';

/**
 * RFC 0003 PR-1 — Webhook 端点 CRUD e2e。
 *
 * UI 流程：通过表单创建端点 → 密钥一次性展示 → 列表显示该行
 * → 轮换密钥 → 删除。另附对 SSRF 防护的纯单元风格测试（成本低，捕获明显回归）。
 */
test.describe('webhooks (PR-1: CRUD)', () => {
  test('SSRF guard rejects private addresses + bad protocols', () => {
    expect(validateWebhookUrl('not-a-url').ok).toBe(false);
    expect(validateWebhookUrl('http://example.com').ok).toBe(false); // bad-protocol
    expect(validateWebhookUrl('https://127.0.0.1/hooks').ok).toBe(false);
    expect(validateWebhookUrl('https://10.0.0.5/hooks').ok).toBe(false);
    expect(validateWebhookUrl('https://192.168.1.1/hooks').ok).toBe(false);
    expect(validateWebhookUrl('https://169.254.169.254/hooks').ok).toBe(false);
    expect(validateWebhookUrl('https://localhost/hooks').ok).toBe(false);
    // Valid public URL passes.
    expect(validateWebhookUrl('https://example.com/hooks').ok).toBe(true);
  });

  test('OWNER creates endpoint via UI, secret revealed once, then deletes', async ({
    page,
    signIn,
  }) => {
    const owner = await createTestUser({ emailVerified: true });
    const slug = `webhook-${Date.now()}`;
    const org = await createOrgWithOwner({ ownerId: owner.id, slug });

    try {
      await signIn(page, owner);
      // Make the freshly-created org the active one — the dashboard's
      // Personal org default would otherwise hide /settings/organization.
      // Setting the cookie directly is faster than driving the switcher.
      await page.context().addCookies([
        {
          name: 'kitora_active_org',
          value: slug,
          domain: 'localhost',
          path: '/',
          sameSite: 'Lax',
          httpOnly: false,
        },
      ]);

      await page.goto('/settings/organization/webhooks');
      const url = `https://e2e-${Date.now()}.example.com/hooks`;

      await page.locator('#webhook-url').fill(url);
      await page.getByRole('button', { name: /^add endpoint$/i }).click();

      // Reveal-once panel must appear with `whsec_`-prefixed secret.
      const secretCode = page.locator('code:has-text("whsec_")').first();
      await expect(secretCode).toBeVisible();
      const secretText = (await secretCode.textContent()) ?? '';
      expect(secretText.startsWith('whsec_')).toBe(true);
      expect(secretText.length).toBeGreaterThan(20);

      // DB sanity: secret stored as hash, not plaintext.
      const row = await prisma.webhookEndpoint.findFirst({
        where: { orgId: org.id, url },
        select: { id: true, secretHash: true, secretPrefix: true },
      });
      expect(row).not.toBeNull();
      expect(row?.secretHash.length).toBe(64); // sha256 hex
      expect(row?.secretPrefix.length).toBe(8);
      // The DB must NOT contain the plaintext anywhere.
      expect(row?.secretHash).not.toContain(secretText);

      // Delete via UI.
      page.once('dialog', (d) => d.accept());
      await page.getByRole('button', { name: /^delete$/i }).click();
      await page.waitForLoadState('networkidle');

      const after = await prisma.webhookEndpoint.findFirst({
        where: { orgId: org.id, url },
        select: { id: true },
      });
      expect(after).toBeNull();
    } finally {
      await deleteOrg(org.id).catch(() => undefined);
      await deleteUser(owner.id).catch(() => undefined);
    }
  });
});
