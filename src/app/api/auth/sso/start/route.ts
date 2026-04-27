import { NextResponse } from 'next/server';

import { env } from '@/env';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { extractDomainFromEmail } from '@/lib/sso/domain';
import { JACKSON_PRODUCT, getOauthController } from '@/lib/sso/jackson';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-2 — `/api/auth/sso/start`
 *
 * SP-initiated SSO 的入口点。接受两种形式：
 *
 *   - Form POST with `email=jane@acme.com` (standard /login form path).
 *   - JSON POST with `{ "email": "jane@acme.com" }` (programmatic).
 *
 * 我们将邮箱域名解析到已启用的 `IdentityProvider` 记录，
 * 再委托给 Jackson 的 OAuth 风格 `authorize` 接口生成重定向 URL。
 *
 * 不到达 IdP 的失败模式 — 坏域、无匹配 IdP、
 * IdP 尚未 `enabledAt` — 返回 302 到 `/login?sso_error=...`，以便 UI
 * 可以呈现有用的内联消息。
 */

const STATE_COOKIE = '__Host-kitora_sso_state';

export async function POST(request: Request) {
  let email: string | null = null;
  let callbackUrl: string | null = null;

  // 接受表单或 JSON。解析失败时关闭 — 其他任何内容都是 400。
  const ct = request.headers.get('content-type') ?? '';
  try {
    if (ct.includes('application/json')) {
      const body = (await request.json()) as { email?: unknown; callbackUrl?: unknown };
      if (typeof body.email === 'string') email = body.email.trim();
      if (typeof body.callbackUrl === 'string') callbackUrl = body.callbackUrl;
    } else {
      const form = await request.formData();
      const e = form.get('email');
      if (typeof e === 'string') email = e.trim();
      const cb = form.get('callbackUrl');
      if (typeof cb === 'string') callbackUrl = cb;
    }
  } catch {
    return NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}/login?sso_error=invalid-input`, 302);
  }

  if (!email) {
    return NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}/login?sso_error=email-required`, 302);
  }

  const domain = extractDomainFromEmail(email);
  if (!domain) {
    return NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}/login?sso_error=bad-email`, 302);
  }

  const idp = await prisma.identityProvider.findFirst({
    where: {
      enabledAt: { not: null },
      // Postgres 数组 `has` 匹配任何元素。
      emailDomains: { has: domain },
    },
    select: {
      id: true,
      protocol: true,
      organization: { select: { slug: true } },
    },
  });
  if (!idp) {
    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/login?sso_error=no-idp&domain=${encodeURIComponent(domain)}`,
      302,
    );
  }

  // 生成 CSRF state 值。Jackson 在回调中回显它；
  // 我们双重检查它与我们刚刚设置的 Cookie 匹配。
  const state = randomBase64Url(24);

  const oauth = await getOauthController();
  let authorize;
  try {
    // Jackson 的 `OAuthReq` 是对 `client_id` 的判别联合：
    //   - `OAuthReqBodyWithClientId` — 传递连接特定的 clientID
    //   - `OAuthReqBodyWithTenantProduct` — 传递 `client_id: 'dummy'` 作为
    //     哨兵 + 实际的 `tenant` + `product` 密钥
    // 我们使用 tenant/product 表单，所以我们不必在其自己的 DB 之外跟踪 Jackson 的
    // 每个连接的 `clientID`。SAML 不使用 PKCE，但类型要求密钥存在 —
    // 在 SAML 路径上接受空字符串。
    authorize = await oauth.authorize({
      client_id: 'dummy',
      tenant: idp.organization.slug,
      product: JACKSON_PRODUCT,
      state,
      response_type: 'code',
      redirect_uri: `${env.NEXT_PUBLIC_APP_URL}/api/auth/sso/callback`,
      code_challenge: '',
      code_challenge_method: '',
    });
  } catch (err) {
    logger.error({ err, providerId: idp.id }, 'sso-authorize-failed');
    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/login?sso_error=authorize-failed`,
      302,
    );
  }

  if (!authorize.redirect_url) {
    logger.error({ providerId: idp.id }, 'sso-authorize-no-redirect');
    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/login?sso_error=authorize-failed`,
      302,
    );
  }

  const res = NextResponse.redirect(authorize.redirect_url, 302);
  // CSRF 缓解：将 state 绑定到用户的浏览器。Cookie 名称使用 `__Host-` 前缀，
  // 所以它只能在确切的主机上通过 HTTPS 设置 + 读取（无子域泄漏）。
  // 5 分钟生存期 — 与 Jackson 的会话窗口匹配。
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NEXT_PUBLIC_APP_URL.startsWith('https://'),
    path: '/',
    maxAge: 60 * 5,
  });
  if (callbackUrl) {
    res.cookies.set('__Host-kitora_sso_cb', callbackUrl, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NEXT_PUBLIC_APP_URL.startsWith('https://'),
      path: '/',
      maxAge: 60 * 5,
    });
  }
  return res;
}

// 平凡的 GET → 405（我们只接受 POST，所以电子邮件不会在
// 访问日志中作为查询参数记录）。
export function GET() {
  return NextResponse.json({ error: 'method-not-allowed' }, { status: 405 });
}

function randomBase64Url(bytes: number): string {
  // 内联而不是使用 `node:crypto` — 保持路由模块图较小。
  // Web Crypto 在 App Router 运行的任何地方都可用。
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  // 手动 base64url；Buffer 仅限 Node，我们已经选择了 `runtime = 'nodejs'`
  // 但保持这个可移植是便宜的。
  let str = '';
  for (const byte of arr) str += String.fromCharCode(byte);
  return globalThis.btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
