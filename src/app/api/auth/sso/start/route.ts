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
 * Entry point for SP-initiated SSO. Two shapes accepted:
 *
 *   - Form POST with `email=jane@acme.com` (the standard /login form path).
 *   - JSON POST with `{ "email": "jane@acme.com" }` (programmatic).
 *
 * We resolve the email domain to an enabled `IdentityProvider` row, then
 * delegate to Jackson's OAuth-style `authorize` to mint a redirect URL.
 *
 * Failure modes that don't reach the IdP — bad domain, no matching IdP,
 * IdP not yet `enabledAt` — return a 302 to `/login?sso_error=...` so the
 * UI can render a useful inline message.
 */

const STATE_COOKIE = '__Host-kitora_sso_state';

export async function POST(request: Request) {
  let email: string | null = null;
  let callbackUrl: string | null = null;

  // Accept either form or JSON. Fail closed — anything else is a 400.
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
      // Postgres-array `has` matches any element exactly.
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

  // Generate a CSRF state value. Jackson echoes it back in the callback;
  // we double-check that it matches the cookie we just set.
  const state = randomBase64Url(24);

  const oauth = await getOauthController();
  let authorize;
  try {
    // Jackson's `OAuthReq` is a discriminated union over `client_id`:
    //   - `OAuthReqBodyWithClientId` — pass the connection-specific clientID
    //   - `OAuthReqBodyWithTenantProduct` — pass `client_id: 'dummy'` as a
    //     sentinel + the actual `tenant` + `product` keys
    // We use the tenant/product form so we don't have to track Jackson's
    // per-connection `clientID` outside its own DB. SAML doesn't use PKCE,
    // but the type requires the keys present — empty strings are accepted
    // on the SAML path.
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
  // CSRF mitigation: bind state to the user's browser. Cookie name uses
  // the `__Host-` prefix so it can only be set + read over HTTPS on the
  // exact host (no subdomain leakage). 5-min lifetime — matches Jackson's
  // session window.
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

// Trivial GET → 405 (we only accept POST so the email isn't logged in
// access logs as a query param).
export function GET() {
  return NextResponse.json({ error: 'method-not-allowed' }, { status: 405 });
}

function randomBase64Url(bytes: number): string {
  // Inline rather than reach for `node:crypto` — keeps the route module
  // graph small. Web Crypto is available everywhere App Router runs.
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  // Manual base64url; Buffer is Node-only and we already opted into
  // `runtime = 'nodejs'` but keeping this portable is cheap.
  let str = '';
  for (const byte of arr) str += String.fromCharCode(byte);
  return globalThis.btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
