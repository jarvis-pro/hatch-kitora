import { createOrgWithOwner, createTestUser, deleteOrg, deleteUser, prisma } from './fixtures/db';
import { expect, test } from '@playwright/test';

import { issueSsoSession } from '../../src/lib/sso/issue-session';
import { provisionSsoUser } from '../../src/lib/sso/jit';

/**
 * RFC 0004 PR-2 — SAML 登录流程 e2e。
 *
 * 完整的 SAML 往返（IdP 侧 XML 签名、ACS 验证、OAuth code → token）
 * 是 jackson 的职责，并已在其仓库中针对真实 X509 fixture 进行单元测试。
 * 我们不在此重复 —— 在 e2e 阶段自签证书 + 手工构造已签名的 AuthnResponse
 * 既脆弱，又测试了错误的东西。
 *
 * 本 spec 改为覆盖链路中属于我们的两端：
 *
 *   1. `/api/auth/sso/start` —— 邮箱解析、域名 → IdP 查找、错误分支。
 *      我们不跟随重定向进入 jackson，因为那需要真实的 IdP 连接。
 *
 *   2. JIT 用户/成员资格创建 + session cookie 铸造。我们直接以
 *      SAML 回调相同的数据格式调用库辅助函数，然后验证生成的 cookie
 *      能解锁 /dashboard。
 *
 * 两者共同守护 Auth.js 所关心的契约：有效的 SSO session 落地于
 * dashboard 并携带预期的用户身份，路由层在进入 jackson 之前拒绝无效请求。
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

      // Plant the cookie on a fresh browser context.
      //
      // 用 `url`-based 形式而不是 `domain + path` —— Playwright 把 URL 解析成
      // host + scheme + path，避免 Chromium 在 host-only `localhost` 域上偶发
      // 把 cookie 当成无效条目悄悄丢弃的兼容坑。`secure` 由 URL 协议自动推导
      // （http → false），与 `issueSsoSession` 输出的 cookie flags 一致。
      const baseURL =
        process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? 3000}`;
      await page.context().addCookies([
        {
          url: baseURL,
          name: cookie.name,
          value: cookie.value,
          httpOnly: cookie.options.httpOnly,
          sameSite: 'Lax',
          expires: Math.floor(Date.now() / 1000) + cookie.options.maxAge,
        },
      ]);

      // /dashboard is auth-gated by middleware; reaching it without a
      // redirect to /login proves the JWT decoded with the right `sub` /
      // `id` / `sessionVersion` shape.
      const res = await page.goto('/dashboard');

      const finalUrl = page.url();
      // 必须命中 dashboard *路径段*。用正则 + `pathname` 收紧避免被
      // `?callbackUrl=%2Fdashboard` 这种 URL 编码后的 callback query 误命中
      //（旧 `toContain('/dashboard')` 在 `…/login?callbackUrl=%2Fdashboard`
      // 形态下行为不可预测）。`/(?:[a-z]{2}\/)?dashboard` 同时覆盖默认
      // locale（/dashboard）和带 locale 前缀（/zh/dashboard）两种合法落点。
      const onDashboard = /^\/(?:[a-z]{2}\/)?dashboard(?:\/|$)/.test(new URL(finalUrl).pathname);

      // Failure-mode diagnostic. When the assertion below trips, the
      // common causes are (a) cookie name / salt mismatch between test
      // process and dev server (env divergence), (b) AUTH_SECRET diff,
      // (c) DeviceSession row racing the request. Dump enough state
      // to tell which one without rerunning. Cheap on the happy path.
      if (!onDashboard) {
        // eslint-disable-next-line no-console
        console.error('SSO test diagnostics:', {
          plantedCookieName: cookie.name,
          plantedCookieSecure: cookie.options.secure,
          baseURL,
          contextCookies: await page.context().cookies(),
          finalUrl,
          finalStatus: res?.status(),
          finalHeaders: res?.headers(),
        });
      }

      expect(res?.status()).toBeLessThan(400);
      expect(onDashboard, `expected to land on /dashboard, got ${finalUrl}`).toBe(true);

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
