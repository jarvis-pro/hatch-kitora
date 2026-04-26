import { NextResponse } from 'next/server';

import { env } from '@/env';
import { logger } from '@/lib/logger';
import { getOauthController } from '@/lib/sso/jackson';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-2 — SAML Assertion Consumer Service.
 *
 * This is the URL the IdP POSTs the SAMLResponse to. We registered it with
 * Jackson at init time (`samlPath: '/api/auth/sso/saml/acs'`) — Jackson
 * itself owns the XML + signature validation; our job is just to pipe the
 * form-encoded `SAMLResponse` + `RelayState` into `oauthController.samlResponse`
 * and follow Jackson's redirect to our OAuth-style callback.
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
    // Jackson signature: it verifies XML signing + audience, mints an OAuth
    // `code` row in its own table, and returns a redirect URL whose query
    // contains `?code=...&state=...` pointing back at our /callback.
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

// IdP-initiated SAML POST is the standard. We don't accept GET on the ACS —
// some IdPs probe with GET first; return 405 so they fall back to POST.
export function GET() {
  return NextResponse.json({ error: 'method-not-allowed' }, { status: 405 });
}
