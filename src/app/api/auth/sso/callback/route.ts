import { NextResponse } from 'next/server';

import { env } from '@/env';
import { recordAudit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { attachSsoSessionCookie, issueSsoSession } from '@/lib/sso/issue-session';
import { JACKSON_PRODUCT, getOauthController } from '@/lib/sso/jackson';
import { provisionSsoUser } from '@/lib/sso/jit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-2 — `GET /api/auth/sso/callback`
 *
 * Receives the OAuth-style `?code=...&state=...` redirect minted by Jackson
 * after a successful SAML assertion (or OIDC code exchange in PR-3). We:
 *
 *   1. Validate the `state` cookie set by `/api/auth/sso/start`.
 *   2. Exchange `code` → `access_token` via Jackson's `oauthController.token`.
 *   3. Fetch userinfo via `oauthController.userInfo`.
 *   4. Resolve the IdP row by Jackson's tenant claim → orgId + defaultRole.
 *   5. JIT user / membership.
 *   6. Issue an Auth.js session cookie + DeviceSession row.
 *   7. Audit `sso.login_succeeded` and redirect to the post-login URL.
 *
 * Every failure path returns a 302 to `/login?sso_error=...` so the UI can
 * surface a friendly inline message (rather than the raw stack).
 */

const STATE_COOKIE = '__Host-kitora_sso_state';
const CALLBACK_COOKIE = '__Host-kitora_sso_cb';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const stateFromUrl = url.searchParams.get('state');
  const errCode = url.searchParams.get('error');

  if (errCode) {
    logger.warn(
      { errCode, errDesc: url.searchParams.get('error_description') },
      'sso-callback-idp-error',
    );
    return failRedirect('idp-rejected');
  }

  if (!code) {
    return failRedirect('missing-code');
  }

  // ── State CSRF check ──────────────────────────────────────────────────
  // The cookie is `__Host-` prefixed so we know it can only have been set
  // over HTTPS on this exact host (or HTTP localhost in dev — Next handles
  // that fall-back automatically when secure=false on /start).
  const stateCookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${STATE_COOKIE}=`))
    ?.slice(STATE_COOKIE.length + 1);

  if (!stateCookie || !stateFromUrl || stateCookie !== stateFromUrl) {
    logger.warn(
      { hasCookie: !!stateCookie, hasUrl: !!stateFromUrl },
      'sso-callback-state-mismatch',
    );
    return failRedirect('state-mismatch');
  }

  // ── Token exchange ────────────────────────────────────────────────────
  const oauth = await getOauthController();
  let tokens;
  try {
    // Jackson's `OAuthTokenReq` is a discriminated union over the auth
    // method. The "client_secret" branch (used here) requires
    // `code_verifier` to be omitted; the "PKCE" branch requires it set.
    // SAML doesn't use PKCE so we send the secret form.
    tokens = await oauth.token({
      grant_type: 'authorization_code',
      client_id: 'dummy',
      client_secret: 'dummy',
      code,
      redirect_uri: `${env.NEXT_PUBLIC_APP_URL}/api/auth/sso/callback`,
    });
  } catch (err) {
    logger.error({ err }, 'sso-token-exchange-failed');
    return failRedirect('token-exchange-failed');
  }

  if (!tokens.access_token) {
    logger.error({ tokens }, 'sso-token-missing-access-token');
    return failRedirect('token-missing');
  }

  // ── Userinfo ──────────────────────────────────────────────────────────
  let info;
  try {
    info = await oauth.userInfo(tokens.access_token);
  } catch (err) {
    logger.error({ err }, 'sso-userinfo-failed');
    return failRedirect('userinfo-failed');
  }

  // Jackson's userInfo response includes `requested.tenant` + `requested.product`
  // metadata — that's how we map back to our `IdentityProvider` row. Fall back
  // to id/email-based heuristics if the field shape diverges across versions.
  const tenant =
    (info as { requested?: { tenant?: string } }).requested?.tenant ??
    (tokens as { tenant?: string }).tenant ??
    null;
  const email = (info as { email?: string }).email ?? null;
  const sub = (info as { id?: string; sub?: string }).id ?? (info as { sub?: string }).sub ?? null;
  const composed =
    [(info as { firstName?: string }).firstName, (info as { lastName?: string }).lastName]
      .filter(Boolean)
      .join(' ')
      .trim() || null;
  const name = (info as { firstName?: string; lastName?: string; name?: string }).name ?? composed;

  if (!tenant || !email || !sub) {
    logger.error(
      { hasTenant: !!tenant, hasEmail: !!email, hasSub: !!sub },
      'sso-userinfo-incomplete',
    );
    return failRedirect('userinfo-incomplete');
  }

  // ── Resolve IdP row (we own it; Jackson owns the connection) ──────────
  const idp = await prisma.identityProvider.findFirst({
    where: {
      enabledAt: { not: null },
      organization: { slug: tenant },
    },
    select: {
      id: true,
      orgId: true,
      defaultRole: true,
      organization: { select: { slug: true } },
    },
  });
  if (!idp) {
    logger.error({ tenant }, 'sso-callback-no-idp');
    return failRedirect('idp-not-found');
  }

  // ── JIT user + membership ─────────────────────────────────────────────
  let jit;
  try {
    jit = await provisionSsoUser({
      providerId: idp.id,
      providerSubject: sub,
      email,
      name,
      orgId: idp.orgId,
      defaultRole: idp.defaultRole,
    });
  } catch (err) {
    logger.error({ err, providerId: idp.id, email }, 'sso-jit-failed');
    return failRedirect('jit-failed');
  }

  // ── Auth.js session cookie ────────────────────────────────────────────
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    request.headers.get('cf-connecting-ip') ??
    null;
  const userAgent = request.headers.get('user-agent');

  const cookie = await issueSsoSession({ userId: jit.userId, userAgent, ip });
  if (!cookie) {
    return failRedirect('user-gone');
  }

  // ── Final redirect ────────────────────────────────────────────────────
  // Honor the original callbackUrl cookie (set in /start), defaulting to
  // /dashboard. Drop the state + callback cookies on the way out — they're
  // single-use.
  const cbCookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${CALLBACK_COOKIE}=`))
    ?.slice(CALLBACK_COOKIE.length + 1);

  const dest = safeCallback(cbCookie) ?? `${env.NEXT_PUBLIC_APP_URL}/dashboard`;
  const res = NextResponse.redirect(dest, 302);
  attachSsoSessionCookie(res, cookie);
  res.cookies.delete(STATE_COOKIE);
  res.cookies.delete(CALLBACK_COOKIE);

  // Audit. Best-effort — the login already succeeded, swallow errors.
  try {
    await recordAudit({
      actorId: jit.userId,
      orgId: idp.orgId,
      action: 'sso.login_succeeded',
      target: idp.id,
      metadata: {
        email,
        firstLogin: jit.userCreated,
      },
    });
  } catch (err) {
    logger.error({ err }, 'sso-audit-write-failed');
  }

  return res;
}

function failRedirect(code: string): NextResponse {
  return NextResponse.redirect(
    `${env.NEXT_PUBLIC_APP_URL}/login?sso_error=${encodeURIComponent(code)}`,
    302,
  );
}

/**
 * Whitelist callbackUrl cookies to *our* origin to prevent open-redirect
 * via crafted `callbackUrl` form fields submitted to /start.
 */
function safeCallback(cb: string | undefined): string | null {
  if (!cb) return null;
  try {
    const decoded = decodeURIComponent(cb);
    const u = new URL(decoded, env.NEXT_PUBLIC_APP_URL);
    if (u.origin !== new URL(env.NEXT_PUBLIC_APP_URL).origin) return null;
    return u.toString();
  } catch {
    return null;
  }
}
