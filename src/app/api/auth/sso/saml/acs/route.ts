import { NextResponse } from 'next/server';

import { env } from '@/env';
import { logger } from '@/lib/logger';
import { getOauthController } from '@/services/sso/jackson';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-2 — SAML 断言消费者服务。
 *
 * 这是 IdP POST SAMLResponse 的 URL。我们在初始化时将其注册到 Jackson
 * （`samlPath: '/api/auth/sso/saml/acs'`）— Jackson 自己拥有 XML + 签名验证；
 * 我们的工作只是将表单编码的 `SAMLResponse` + `RelayState` 传递到 `oauthController.samlResponse`
 * 并跟随 Jackson 重定向到我们的 OAuth 风格的回调。
 */
export async function POST(request: Request) {
  let SAMLResponse: string | null = null;
  let RelayState: string | null = null;
  try {
    const form = await request.formData();
    const sr = form.get('SAMLResponse');
    if (typeof sr === 'string') SAMLResponse = sr;
    const rs = form.get('RelayState');
    if (typeof rs === 'string') RelayState = rs;
  } catch {
    return NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}/login?sso_error=acs-bad-form`, 302);
  }

  if (!SAMLResponse) {
    return NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}/login?sso_error=acs-no-response`, 302);
  }

  const oauth = await getOauthController();
  let result;
  try {
    // Jackson 签名：它验证 XML 签名 + 受众，在其自己的表中铸造 OAuth `code` 行，
    // 并返回重定向 URL，其查询包含 `?code=...&state=...` 指向我们的 /callback。
    result = await oauth.samlResponse({ SAMLResponse, RelayState: RelayState ?? '' });
  } catch (err) {
    logger.error({ err }, 'sso-saml-response-failed');
    return NextResponse.redirect(
      `${env.NEXT_PUBLIC_APP_URL}/login?sso_error=acs-validation-failed`,
      302,
    );
  }

  if (!result.redirect_url) {
    logger.error({ result }, 'sso-saml-response-no-redirect');
    return NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}/login?sso_error=acs-no-redirect`, 302);
  }

  return NextResponse.redirect(result.redirect_url, 302);
}

// IdP 发起的 SAML POST 是标准。我们不接受 ACS 上的 GET —
// 某些 IdP 首先使用 GET 探测；返回 405 以便它们回退到 POST。
export function GET() {
  return NextResponse.json({ error: 'method-not-allowed' }, { status: 405 });
}
