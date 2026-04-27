import { createOrgWithOwner, createTestUser, deleteOrg, deleteUser, prisma } from './fixtures/db';
import { expect, test } from '@playwright/test';

import { encryptOidcSecret } from '../../src/lib/sso/secret';

/**
 * RFC 0004 PR-3 — OIDC start 端点冒烟测试。
 *
 * 与 SAML spec 一样，我们不在 e2e 时搭建真实的 OIDC IdP ——
 * 那意味着要运行带真实 RSA 密钥对的 `oidc-provider` 实例、
 * 生成 discovery + JWKS 响应等。我们能验证的契约：draft OIDC IdP
 * 行可通过 `/start` 访问，且路由逻辑不会把 OIDC 误当 SAML 处理
 *（反之亦然）。
 *
 * 完整的 code → token → userInfo 往返由 jackson 自身的集成测试覆盖；
 * 我们的 `/oidc/callback` 路由只是通往 `oauthController.oidcAuthzResponse`
 * 的薄管道。
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
