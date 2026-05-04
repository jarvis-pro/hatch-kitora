import { NextResponse } from 'next/server';

import { env } from '@/env';
import { recordAudit } from '@/services/audit';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { attachSsoSessionCookie, issueSsoSession } from '@/services/sso/issue-session';
import { getOauthController } from '@/services/sso/jackson';
import { provisionSsoUser } from '@/services/sso/jit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-2 — `GET /api/auth/sso/callback`
 *
 * 接收 Jackson 在成功的 SAML 断言（或 PR-3 中的 OIDC 代码交换）后生成的 OAuth 风格的 `?code=...&state=...` 重定向。我们：
 *
 *   1. 验证由 `/api/auth/sso/start` 设置的 `state` Cookie。
 *   2. 通过 Jackson 的 `oauthController.token` 交换 `code` → `access_token`。
 *   3. 通过 `oauthController.userInfo` 获取用户信息。
 *   4. 通过 Jackson 的 tenant 声明解析 IdP 行 → orgId + defaultRole。
 *   5. JIT 用户/成员资格。
 *   6. 颁发 Auth.js 会话 Cookie + DeviceSession 行。
 *   7. 审计 `sso.login_succeeded` 并重定向到登录后 URL。
 *
 * 每个失败路径都返回 302 到 `/login?sso_error=...`，以便 UI 可以显示友好的内联消息（而不是原始堆栈）。
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

  // ── State CSRF 检查 ──────────────────────────────────────────────────
  // Cookie 有 `__Host-` 前缀，所以我们知道它只能在 HTTPS 上在这个确切的主机上设置
  // （或在开发中 HTTP localhost — 当 /start 上的 secure=false 时 Next 会自动处理该回退）。
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

  // ── 令牌交换 ────────────────────────────────────────────────────
  const oauth = await getOauthController();
  let tokens;
  try {
    // Jackson 的 `OAuthTokenReq` 是对认证方法的判别联合。
    // "client_secret" 分支（在此处使用）要求省略 `code_verifier`；
    // "PKCE" 分支要求设置它。
    // SAML 不使用 PKCE，所以我们发送密钥表单。
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

  // ── 用户信息 ──────────────────────────────────────────────────────────
  let info;
  try {
    info = await oauth.userInfo(tokens.access_token);
  } catch (err) {
    logger.error({ err }, 'sso-userinfo-failed');
    return failRedirect('userinfo-failed');
  }

  // Jackson 的 userInfo 响应包括 `requested.tenant` + `requested.product` 元数据
  // — 这是我们如何映射回我们的 `IdentityProvider` 行。如果字段形状在不同版本之间偏差，
  // 则回退到基于 id/email 的启发式方法。
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

  // ── 解析 IdP 行（我们拥有它；Jackson 拥有连接）──────────
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

  // ── JIT 用户 + 成员资格 ─────────────────────────────────────────────
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

  // ── Auth.js 会话 Cookie ────────────────────────────────────────────
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

  // ── 最终重定向 ────────────────────────────────────────────────────
  // 遵守原始 callbackUrl Cookie（在 /start 中设置），默认为 /dashboard。
  // 在退出时删除 state + callback Cookie — 它们是一次性的。
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

  // 审计。尽力而为 — 登录已经成功，忽略错误。
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
 * 白名单 callbackUrl Cookie 到 *我们的* 源以防止通过提交到 /start 的精心制作的
 * `callbackUrl` 表单字段进行开放式重定向。
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
