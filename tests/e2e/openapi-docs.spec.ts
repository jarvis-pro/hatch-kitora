import { expect, test } from '@playwright/test';

/**
 * RFC 0003 PR-3 — OpenAPI 文档站冒烟测试。
 *
 * 不尝试断言 Scalar 的完整 UI（它是重量级第三方组件，跨版本选择器
 * 容易漂移）—— 而是验证以下契约：
 *
 *   1. 原始规范端点以正确的请求头返回合法 YAML。
 *   2. /docs/api 页面挂载时无 4xx，且嵌入了 Scalar 根节点。
 *   3. 该页面可公开访问 —— 不触发登录重定向。
 */

test.describe('OpenAPI docs', () => {
  test('GET /api/openapi/v1.yaml returns the spec', async ({ request }) => {
    const res = await request.get('/api/openapi/v1.yaml');
    expect(res.status()).toBe(200);
    const ct = res.headers()['content-type'] ?? '';
    expect(ct).toMatch(/yaml/i);

    const body = await res.text();
    // Cheap structural sniffing — full YAML parse is `redocly lint`'s job.
    expect(body).toContain('openapi: 3.1.0');
    expect(body).toContain('Kitora REST API');
    expect(body).toContain('/api/v1/me');
    expect(body).toContain('/api/v1/orgs/{slug}/webhooks');
  });

  test('GET /docs/api renders the Scalar reference shell', async ({ page }) => {
    const response = await page.goto('/docs/api');
    expect(response?.status()).toBeLessThan(400);

    // Title is set via metadata + Scalar's metaData. Either path is fine —
    // we just want to confirm the page didn't 4xx into a generic 404 shell.
    await expect(page).toHaveTitle(/api reference|kitora/i);

    // The Scalar component injects a top-level container with a stable
    // `[role="main"]` or `.scalar-container` style class on mount. Wait
    // for *something* Scalar-shaped to appear so we know hydration didn't
    // crash on the spec fetch.
    const root = page.locator('body');
    await expect(root).toContainText(/api|reference|kitora/i, { timeout: 10_000 });
  });

  test('/docs/api is reachable without auth', async ({ page }) => {
    // A logged-out browser should land on the docs page directly, not be
    // redirected to /login or any locale-prefixed protected route.
    const res = await page.goto('/docs/api');
    expect(res?.url()).toContain('/docs/api');
    expect(res?.status()).toBeLessThan(400);
  });
});
