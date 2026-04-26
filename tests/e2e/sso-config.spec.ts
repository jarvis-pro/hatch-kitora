import { createOrgWithOwner, createTestUser, deleteOrg, deleteUser, prisma } from './fixtures/db';
import { expect, test } from './fixtures/test';

import { validateEmailDomain } from '../../src/lib/sso/domain';
import {
  decryptOidcSecret,
  encryptOidcSecret,
  generateScimToken,
  hashScimToken,
} from '../../src/lib/sso/secret';

/**
 * RFC 0004 PR-1 — IdP CRUD + SCIM token e2e.
 *
 * Two slices:
 *
 *   1. Pure unit-style assertions over the secret + domain helpers.
 *      Fast feedback for HKDF / hash regressions.
 *   2. UI flow: OWNER navigates to /settings/organization/sso, adds a SAML
 *      provider, generates a SCIM token (revealed once), then deletes.
 *
 * Mirrors webhooks.spec.ts in shape so you can lift the cookie-set / sign-in
 * pattern directly when adding more SSO scenarios.
 */

test.describe('sso config (PR-1: IdP CRUD)', () => {
  test('email domain validator accepts hostnames + rejects garbage', () => {
    expect(validateEmailDomain('acme.com').ok).toBe(true);
    expect(validateEmailDomain('Acme.IO').ok).toBe(true); // case-insensitive
    expect(validateEmailDomain('multi.subdomain.example.com').ok).toBe(true);

    expect(validateEmailDomain('').ok).toBe(false);
    expect(validateEmailDomain('no-tld').ok).toBe(false);
    expect(validateEmailDomain('*.acme.com').ok).toBe(false); // wildcard rejected
    expect(validateEmailDomain('acme.123').ok).toBe(false); // numeric TLD
    expect(validateEmailDomain('acme com').ok).toBe(false); // space
  });

  test('encryptOidcSecret + decryptOidcSecret round-trip per provider id', () => {
    const plain = 'oidc-super-secret-value';
    const ct = encryptOidcSecret('idp-abc', plain);
    expect(ct.length).toBeGreaterThan(plain.length); // grew with iv+tag

    const round = encryptOidcSecret('idp-abc', plain);
    expect(round.equals(ct)).toBe(false); // randomised iv

    expect(decryptOidcSecret('idp-abc', ct)).toBe(plain);
  });

  test('generateScimToken yields sha256-stable hash + 8-char prefix', () => {
    const fresh = generateScimToken();
    expect(fresh.plain.startsWith('scim_')).toBe(true);
    expect(fresh.prefix.length).toBe(8);
    expect(fresh.hash).toBe(hashScimToken(fresh.plain));
    expect(hashScimToken(fresh.plain)).toMatch(/^[a-f0-9]{64}$/);
  });

  test('OWNER creates SAML provider via UI, generates SCIM token, deletes', async ({
    page,
    signIn,
  }) => {
    const owner = await createTestUser({ emailVerified: true });
    const slug = `sso-${Date.now()}`;
    const org = await createOrgWithOwner({ ownerId: owner.id, slug });

    try {
      await signIn(page, owner);
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

      await page.goto('/settings/organization/sso');

      // Pick SAML in the add form.
      await page.getByRole('button', { name: /^saml$/i }).click();

      const samlMetadata =
        '<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.com">' +
        '<IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"/>' +
        '</EntityDescriptor>';

      await page.locator('#sso-name').fill('Okta E2E');
      await page.locator('#sso-domains').fill('e2e.example.com');
      await page.locator('#sso-saml').fill(samlMetadata);
      await page.getByRole('button', { name: /^create provider$/i }).click();

      // The new provider row should appear with protocol pill and the
      // configured display name.
      await expect(page.getByText('Okta E2E')).toBeVisible();
      await expect(page.locator('text=SAML').first()).toBeVisible();

      // Generate the SCIM token. Confirm-prompt is bypassed because the row
      // has no token yet (button label is "Generate SCIM token").
      page.once('dialog', (d) => d.accept());
      await page.getByRole('button', { name: /generate scim token/i }).click();

      // Reveal-once banner shows a `scim_`-prefixed token.
      const tokenCode = page.locator('code:has-text("scim_")').first();
      await expect(tokenCode).toBeVisible();
      const tokenText = (await tokenCode.textContent()) ?? '';
      expect(tokenText.startsWith('scim_')).toBe(true);

      // Confirm the row stored the corresponding hash + prefix.
      const idp = await prisma.identityProvider.findFirstOrThrow({
        where: { orgId: org.id },
        select: { id: true, scimTokenHash: true, scimTokenPrefix: true },
      });
      expect(idp.scimTokenHash).toBe(hashScimToken(tokenText));
      expect(tokenText).toContain(idp.scimTokenPrefix ?? '');

      // Acknowledge the reveal banner.
      await page.getByRole('button', { name: /i've stored the token/i }).click();

      // Delete the provider.
      page.once('dialog', (d) => d.accept());
      await page.getByRole('button', { name: /^delete$/i }).click();

      await expect
        .poll(async () => prisma.identityProvider.count({ where: { orgId: org.id } }))
        .toBe(0);
    } finally {
      await deleteOrg(org.id).catch(() => undefined);
      await deleteUser(owner.id).catch(() => undefined);
    }
  });
});
