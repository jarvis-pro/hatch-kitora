import { expect, test } from './fixtures/test';

test.describe('api tokens', () => {
  test('create token, call /api/v1/me with it', async ({ testUser, page, signIn, request }) => {
    await signIn(page, testUser);
    await page.goto('/settings');

    // Create a token via the settings card.
    const tokenName = `e2e-${Date.now()}`;
    await page.getByLabel(/token name/i).fill(tokenName);
    await page.getByRole('button', { name: /generate token/i }).click();

    // Reveal block shows the raw token in a <code> — pull it out.
    const revealed = page.locator('code', { hasText: /^kitora_/ });
    await expect(revealed).toBeVisible();
    const raw = (await revealed.textContent())?.trim();
    expect(raw, 'expected a kitora_ prefixed token').toMatch(/^kitora_[A-Za-z0-9_-]{20,}$/);

    // Hit the public endpoint with that token.
    const res = await request.get('/api/v1/me', {
      headers: { authorization: `Bearer ${raw}` },
    });
    expect(res.status(), 'GET /api/v1/me should accept the token').toBe(200);
    const body = (await res.json()) as { id: string; email: string };
    expect(body.email).toBe(testUser.email);
  });

  test('invalid bearer is 401', async ({ request }) => {
    const res = await request.get('/api/v1/me', {
      headers: { authorization: 'Bearer kitora_definitelyNotARealTokenXXXXXXXXXXXXX' },
    });
    expect(res.status()).toBe(401);
  });

  test('missing bearer is 401', async ({ request }) => {
    const res = await request.get('/api/v1/me');
    expect(res.status()).toBe(401);
  });
});
