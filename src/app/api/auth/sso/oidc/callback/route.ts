import { NextResponse } from 'next/server';

import { env } from '@/env';
import { logger } from '@/lib/logger';
import { getOauthController } from '@/services/sso/jackson';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-3 — OIDC 重定向 URI。
 *
 * Jackson 配置了 `oidcPath: '/api/auth/sso/oidc/callback'` —
 * IdP 在用户身份验证后使用 `?code&state` 重定向到这里。
 * 此路由将查询交给 Jackson 的 `oidcAuthzResponse`，它
 * 将 OIDC 代码交换为令牌，在 Jackson 的会话表中铸造它自己的 OAuth 代码，
 * 并返回重定向 URL 回到应用程序的注册 redirect_uri（= 我们的 `/api/auth/sso/callback`）。
 *
 * 在此重定向之后，流程的其余部分与 SAML 相同 —
 * 通用 `/callback` 处理程序执行令牌交换、userInfo、JIT 和 Auth.js 会话铸造。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errCode = url.searchParams.get('error');

  if (errCode) {
    logger.warn(
      { errCode, errDesc: url.searchParams.get('error_description') },
      'sso-oidc-idp-error',
    );
    return NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}/login?sso_error=idp-rejected`, 302);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}/login?sso_error=missing-code`, 302);
  }

  const oauth = await getOauthController();
  let result;
  try {
    result = await oauth.oidcAuthzResponse({ code, state });
  } catch (err) {
    logger.error({ err }, 'sso-oidc-authz-response-failed');
    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/login?sso_error=acs-validation-failed`,
      302,
    );
  }

  if (!result.redirect_url) {
    logger.error({ result }, 'sso-oidc-authz-no-redirect');
    return NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}/login?sso_error=acs-no-redirect`, 302);
  }

  return NextResponse.redirect(result.redirect_url, 302);
}
