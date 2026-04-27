import { createOrgWithOwner, createTestUser, deleteOrg, deleteUser, prisma } from './fixtures/db';
import { expect, test } from '@playwright/test';

import { issueSsoSession } from '../../src/lib/sso/issue-session';
import { provisionSsoUser } from '../../src/lib/sso/jit';

/**
 * RFC 0004 PR-2 — SAML login flow e2e.
 *
 * The full SAML round-trip (IdP-side XML signing, ACS validation, OAuth
 * code → token) is jackson's responsibility and is unit-tested in their
 * repo against real X509 fixtures. We don't reproduce that here — building
 * a self-signed cert + crafting a signed AuthnResponse at e2e time is
 * brittle and tests the wrong thing.
 *
 * Instead this spec covers the two ends of the chain that ARE ours:
 *
 *   1. `/api/auth/sso/start` — email parsing, domain → IdP lookup, error
 *      branches. We don't follow the redirect into jackson because that
 *      requires a real IdP connection.
 *
 *   2. JIT user/membership creation + session cookie minting. We call the
 *      library helpers directly with the same shape the SAML callback
 *      would, then prove the resulting cookie unlocks /dashboard.
 *
 * Together these guard the contract Auth.js cares about: a valid SSO
 * session lands on the dashboard with the expected user identity, and the
 * routing layer rejects nonsense before it hits jackson.
 */

test.describe('sso saml login (PR-2)', () => {
  test('/api/auth/sso/start surfaces routing errors as ?sso_error=…', async ({ request }) => {
    // Playwright's APIRequestContext follows redirects by default. We want to
    // see the 302 directly to assert on the `sso_error=…` query param, so
    // pass `maxRedirects: 0` per call.
    const noFollow = { maxRedirects: 0 } as const;

    // Empty body → email-required
    const empty = await request.post('/api/auth/sso/start', {
      multipart: {},
      ...noFollow,
    });
    expect(empty.status()).toBe(302);
    const loc1 = empty.headers()['location'] ?? '';
    expect(loc1).toContain('sso_error=email-required');

    // Garbage email → bad-email
    const bad = await request.post('/api/auth/sso/start', {
      multipart: { email: 'not-an-email' },
      ...noFollow,
    });
    expect(bad.status()).toBe(302);
    expect(bad.headers()['location'] ?? '').toContain('sso_error=bad-email');

    // Valid email format but no IdP for that domain → no-idp
    const orphan = await request.post('/api/auth/sso/start', {
      multipart: { email: `nobody+${Date.now()}@unconfigured-domain.example` },
      ...noFollow,
    });
    expect(orphan.status()).toBe(302);
    expect(orphan.headers()['location'] ?? '').toContain('sso_error=no-idp');
  });

  test('JIT-provisioned SSO user lands on /dashboard with a fresh session', async ({ page }) => {
    // Stage: an OWNER + org + enabled SAML IdP row. We don't push to jackson —
    // this test bypasses the SAML XML round-trip and goes straight from JIT
    // to session issuance.
    const owner = await createTestUser({ emailVerified: true });
    const slug = `sso-login-${Date.now()}`;
    const org = await createOrgWithOwner({ ownerId: owner.id, slug });

    let provisionedUserId: string | null = null;

    try {
      const idp = await prisma.identityProvider.create({
        data: {
          orgId: org.id,
          name: 'E2E IdP',
          protocol: 'SAML',
          emailDomains: ['e2e-jit.example.com'],
          defaultRole: 'MEMBER',
          enabledAt: new Date(), // live → routing layer would accept it
          // Stub metadata is fine: we never call jackson in this test.
          samlMetadata: '<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata"/>',
        },
        select: { id: true, orgId: true, defaultRole: true },
      });

      // Simulate what the SSO callback does post-userInfo.
      const subject = `e2e-sub-${Date.now()}`;
      const email = `jane+${Date.now()}@e2e-jit.example.com`;
      const jit = await provisionSsoUser({
        providerId: idp.id,
        providerSubject: subject,
        email,
        name: 'Jane SSO',
        orgId: idp.orgId,
        defaultRole: idp.defaultRole,
      });
      expect(jit.userCreated).toBe(true); // brand-new user path
      provisionedUserId = jit.userId;

      // Verify the JIT row shape — providerSubject + emailVerified set.
      const created = await prisma.user.findUniqueOrThrow({
        where: { id: jit.userId },
        select: { email: true, emailVerified: true },
      });
      expect(created.email).toBe(email.toLowerCase());
      expect(created.emailVerified).not.toBeNull();

      const membership = await prisma.membership.findFirstOrThrow({
        where: { userId: jit.userId, orgId: idp.orgId },
        select: { providerId: true, providerSubject: true, role: true },
      });
      expect(membership.providerId).toBe(idp.id);
      expect(membership.providerSubject).toBe(subject);
      expect(membership.role).toBe('MEMBER');

      // Audit row: actor null = system-issued.
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'sso.jit_user_created', target: jit.userId },
        select: { actorId: true },
      });
      expect(audit).not.toBeNull();
      expect(audit?.actorId).toBeNull();

      // Mint the session cookie + DeviceSession row.
      const cookie = await issueSsoSession({
        userId: jit.userId,
        userAgent: 'Playwright E2E',
        ip: '127.0.0.1',
      });
      if (!cookie) throw new Error('issueSsoSession returned null');

      // Plant the cookie on a fresh browser context. We map the dev cookie
      // name unconditionally — Playwright's webServer runs the app on
      // http://localhost so the `__Secure-` prefix isn't expected.
      await page.context().addCookies([
        {
          name: cookie.name,
          value: cookie.value,
          domain: 'localhost',
          path: '/',
          httpOnly: cookie.options.httpOnly,
          sameSite: 'Lax',
          secure: false,
          expires: Math.floor(Date.now() / 1000) + cookie.options.maxAge,
        },
      ]);

      // /dashboard is auth-gated by middleware; reaching it without a
      // redirect to /login proves the JWT decoded with the right `sub` /
      // `id` / `sessionVersion` shape.
      const res = await page.goto('/dashboard');

      // Failure-mode diagnostic. When the assertion below trips, the
      // common causes are (a) cookie name / salt mismatch between test
      // process and dev server (env divergence), (b) AUTH_SECRET diff,
      // (c) DeviceSession row racing the request. Dump enough state
      // to tell which one without rerunning. Cheap on the happy path.
      if (!page.url().includes('/dashboard')) {
        // eslint-disable-next-line no-console
        console.error('SSO test diagnostics:', {
          plantedCookieName: cookie.name,
          plantedCookieSecure: cookie.options.secure,
          contextCookies: await page.context().cookies(),
          finalUrl: page.url(),
          finalStatus: res?.status(),
          finalHeaders: res?.headers(),
        });
      }

      expect(res?.status()).toBeLessThan(400);
      expect(page.url()).toContain('/dashboard');

      const deviceSessionCount = await prisma.deviceSession.count({
        where: { userId: jit.userId },
      });
      expect(deviceSessionCount).toBeGreaterThan(0);
    } finally {
      if (provisionedUserId) {
        await deleteUser(provisionedUserId).catch(() => undefined);
      }
      await deleteOrg(org.id).catch(() => undefined);
      await deleteUser(owner.id).catch(() => undefined);
    }
  });

  test('re-login by the same providerSubject reuses the existing user row', async () => {
    const owner = await createTestUser({ emailVerified: true });
    const slug = `sso-relogin-${Date.now()}`;
    const org = await createOrgWithOwner({ ownerId: owner.id, slug });
    let firstUserId: string | null = null;

    try {
      const idp = await prisma.identityProvider.create({
        data: {
          orgId: org.id,
          name: 'E2E IdP',
          protocol: 'SAML',
          emailDomains: ['e2e-relogin.example.com'],
          defaultRole: 'MEMBER',
          enabledAt: new Date(),
          samlMetadata: '<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata"/>',
        },
        select: { id: true, orgId: true, defaultRole: true },
      });

      const subject = `same-sub-${Date.now()}`;
      const email1 = `jane+${Date.now()}@e2e-relogin.example.com`;

      const first = await provisionSsoUser({
        providerId: idp.id,
        providerSubject: subject,
        email: email1,
        name: 'Jane',
        orgId: idp.orgId,
        defaultRole: idp.defaultRole,
      });
      firstUserId = first.userId;
      expect(first.userCreated).toBe(true);

      // IT rotates the user's email — same NameID. Should resolve the same
      // User row, NOT create a duplicate.
      const second = await provisionSsoUser({
        providerId: idp.id,
        providerSubject: subject,
        email: `jane.smith+${Date.now()}@e2e-relogin.example.com`,
        name: 'Jane Smith',
        orgId: idp.orgId,
        defaultRole: idp.defaultRole,
      });
      expect(second.userId).toBe(first.userId);
      expect(second.userCreated).toBe(false);
    } finally {
      if (firstUserId) await deleteUser(firstUserId).catch(() => undefined);
      await deleteOrg(org.id).catch(() => undefined);
      await deleteUser(owner.id).catch(() => undefined);
    }
  });
});
