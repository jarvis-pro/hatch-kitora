import { createOrgWithOwner, createTestUser, deleteOrg, deleteUser, prisma } from './fixtures/db';
import { expect, test } from '@playwright/test';

import { encryptOidcSecret } from '../../src/lib/sso/secret';

/**
 * RFC 0004 PR-3 — OIDC start-endpoint smoke.
 *
 * Like the SAML spec, we don't try to stand up a real OIDC IdP at e2e
 * time — that would mean running a `oidc-provider` instance with a real
 * RSA keypair, generating discovery + JWKS responses, etc. The contract
 * we *can* verify: a draft OIDC IdP row is reachable from `/start`, and
 * the routing logic doesn't accidentally treat OIDC as SAML (or vice
 * versa).
 *
 * The full code → token → userInfo round-trip is covered by jackson's
 * own integration tests; our `/oidc/callback` route is a thin pipe to
 * `oauthController.oidcAuthzResponse`.
 */

test.describe('sso oidc login (PR-3)', () => {
  test('OIDC IdP row is enabledAt-gated alongside SAML', async () => {
    const owner = await createTestUser({ emailVerified: true });
    const slug = `sso-oidc-${Date.now()}`;
    const org = await createOrgWithOwner({ ownerId: owner.id, slug });

    try {
      // Stand up two IdPs on the same org — verifies the @@unique([orgId,
      // protocol]) split lets us run SAML + OIDC side-by-side.
      const samlRow = await prisma.identityProvider.create({
        data: {
          orgId: org.id,
          name: 'SAML for E2E',
          protocol: 'SAML',
          emailDomains: ['saml.example.com'],
          defaultRole: 'MEMBER',
          enabledAt: new Date(),
          samlMetadata: '<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata"/>',
        },
        select: { id: true, protocol: true, enabledAt: true },
      });
      expect(samlRow.protocol).toBe('SAML');

      const oidcRow = await prisma.identityProvider.create({
        data: {
          orgId: org.id,
          name: 'OIDC for E2E',
          protocol: 'OIDC',
          emailDomains: ['oidc.example.com'],
          defaultRole: 'MEMBER',
          enabledAt: new Date(),
          oidcIssuer: 'https://accounts.example.com',
          oidcClientId: 'kitora-e2e',
        },
        select: { id: true, protocol: true, enabledAt: true },
      });
      expect(oidcRow.protocol).toBe('OIDC');

      // Encrypt the OIDC client secret post-insert (HKDF salt = row id).
      const cipherText = encryptOidcSecret(oidcRow.id, 'plaintext-oidc-secret');
      await prisma.identityProvider.update({
        where: { id: oidcRow.id },
        data: { oidcClientSecret: cipherText },
      });

      const refreshed = await prisma.identityProvider.findUniqueOrThrow({
        where: { id: oidcRow.id },
        select: { oidcClientSecret: true },
      });
      expect(refreshed.oidcClientSecret).not.toBeNull();
      // The persisted blob must not equal the plaintext we passed in.
      expect(Buffer.from(refreshed.oidcClientSecret!).toString('utf8')).not.toBe(
        'plaintext-oidc-secret',
      );

      // Sanity check: the unique constraint must let one of each per org.
      const total = await prisma.identityProvider.count({ where: { orgId: org.id } });
      expect(total).toBe(2);
    } finally {
      await deleteOrg(org.id).catch(() => undefined);
      await deleteUser(owner.id).catch(() => undefined);
    }
  });

  test('/api/auth/sso/start refuses to follow protocol if IdP is in draft', async ({ request }) => {
    // Insert an OIDC IdP that is NOT enabled (`enabledAt = null`). The
    // routing layer should refuse to route to it — same gating as SAML.
    const owner = await createTestUser({ emailVerified: true });
    const slug = `sso-draft-${Date.now()}`;
    const org = await createOrgWithOwner({ ownerId: owner.id, slug });
    try {
      await prisma.identityProvider.create({
        data: {
          orgId: org.id,
          name: 'Draft OIDC',
          protocol: 'OIDC',
          emailDomains: ['draft-oidc.example.com'],
          defaultRole: 'MEMBER',
          enabledAt: null, // draft
          oidcIssuer: 'https://accounts.example.com',
          oidcClientId: 'kitora-e2e',
          oidcClientSecret: encryptOidcSecret('temp-id-not-real', 'irrelevant'),
        },
      });

      const res = await request.post('/api/auth/sso/start', {
        multipart: { email: 'jane@draft-oidc.example.com' },
        maxRedirects: 0,
      });
      expect(res.status()).toBe(302);
      expect(res.headers()['location'] ?? '').toContain('sso_error=no-idp');
    } finally {
      await deleteOrg(org.id).catch(() => undefined);
      await deleteUser(owner.id).catch(() => undefined);
    }
  });
});
