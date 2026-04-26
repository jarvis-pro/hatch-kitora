import { NextResponse } from 'next/server';

import { env } from '@/env';
import { logger } from '@/lib/logger';
import { getOauthController } from '@/lib/sso/jackson';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-3 — OIDC redirect URI.
 *
 * Jackson is configured with `oidcPath: '/api/auth/sso/oidc/callback'` —
 * the IdP redirects here with `?code&state` after the user authenticates.
 * This route hands the query off to Jackson's `oidcAuthzResponse`, which
 * exchanges the OIDC code for tokens, mints its OWN OAuth code in
 * Jackson's session table, and returns a redirect_url back to the app's
 * registered redirect_uri (= our `/api/auth/sso/callback`).
 *
 * After this redirect, the rest of the flow is identical to SAML — the
 * generic `/callback` handler does token exchange, userInfo, JIT, and
 * Auth.js session minting.
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
