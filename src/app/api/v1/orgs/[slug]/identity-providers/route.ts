import { NextResponse } from 'next/server';

import { gateOrgApi } from '@/lib/api-org-gate';
import { prisma } from '@/lib/db';
import { apiLimiter } from '@/lib/rate-limit';
import { validateEmailDomain } from '@/lib/sso/domain';
import { encryptOidcSecret } from '@/lib/sso/secret';
import { OrgRole, SsoProtocol } from '@prisma/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 0004 PR-1 — `GET /api/v1/orgs/{slug}/identity-providers` 和 `POST` 创建。
 *
 *   curl -H "Authorization: Bearer kitora_..." \
 *        https://app.kitora.com/api/v1/orgs/acme/identity-providers
 *
 *   curl -X POST -H "Authorization: Bearer kitora_..." \
 *        -H "Content-Type: application/json" \
 *        -d '{"protocol":"SAML","name":"Okta","samlMetadata":"<...>","emailDomains":["acme.com"]}' \
 *        https://app.kitora.com/api/v1/orgs/acme/identity-providers
 *
 * Token 必须绑定到指定的组织（RFC 0001 §9），并属于一个拥有 OWNER 或 ADMIN 角色的用户。
 * POST 不会返回密钥 —— OIDC 客户端密钥是只读的，SCIM token 通过单独的
 * rotate-scim-token 端点生成。
 */

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const gate = await gateOrgApi({ request, orgSlug: slug });
  if (!gate.ok)
    return NextResponse.json({ error: errorCode(gate.status) }, { status: gate.status });

  const { success, remaining, reset } = await apiLimiter.limit(`api:${gate.principal.tokenId}`);
  if (!success) return rateLimited(reset);

  const providers = await prisma.identityProvider.findMany({
    where: { orgId: gate.orgId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      protocol: true,
      emailDomains: true,
      defaultRole: true,
      enforceForLogin: true,
      enabledAt: true,
      scimEnabled: true,
      scimTokenPrefix: true,
      oidcIssuer: true,
      oidcClientId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json(
    {
      data: providers.map((p) => ({
        id: p.id,
        name: p.name,
        protocol: p.protocol,
        emailDomains: p.emailDomains,
        defaultRole: p.defaultRole,
        enforceForLogin: p.enforceForLogin,
        enabledAt: p.enabledAt?.toISOString() ?? null,
        scimEnabled: p.scimEnabled,
        scimTokenPrefix: p.scimTokenPrefix,
        oidcIssuer: p.oidcIssuer,
        oidcClientId: p.oidcClientId,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      })),
    },
    { headers: rateHeaders(remaining, reset) },
  );
}

interface CreateBody {
  protocol?: unknown;
  name?: unknown;
  emailDomains?: unknown;
  defaultRole?: unknown;
  enforceForLogin?: unknown;
  samlMetadata?: unknown;
  oidcIssuer?: unknown;
  oidcClientId?: unknown;
  oidcClientSecret?: unknown;
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const gate = await gateOrgApi({ request, orgSlug: slug });
  if (!gate.ok)
    return NextResponse.json({ error: errorCode(gate.status) }, { status: gate.status });

  const { success, remaining, reset } = await apiLimiter.limit(`api:${gate.principal.tokenId}`);
  if (!success) return rateLimited(reset);

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }

  if (body.protocol !== 'SAML' && body.protocol !== 'OIDC') {
    return NextResponse.json({ error: 'invalid-protocol' }, { status: 400 });
  }
  const protocol = body.protocol as SsoProtocol;

  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    return NextResponse.json({ error: 'invalid-name' }, { status: 400 });
  }

  // 获取调用方在该组织的角色，用于 OWNER 专属的 enforce 标志验证。
  const callerMembership = await prisma.membership.findFirst({
    where: { userId: gate.principal.userId, orgId: gate.orgId },
    select: { role: true },
  });
  const callerRole = callerMembership?.role ?? OrgRole.MEMBER;

  const enforceForLogin = body.enforceForLogin === true;
  if (enforceForLogin && callerRole !== OrgRole.OWNER) {
    return NextResponse.json({ error: 'enforce-owner-only' }, { status: 403 });
  }

  // emailDomains 验证
  const rawDomains = Array.isArray(body.emailDomains) ? body.emailDomains : [];
  const emailDomains: string[] = [];
  for (const d of rawDomains) {
    if (typeof d !== 'string') {
      return NextResponse.json({ error: 'invalid-domain' }, { status: 400 });
    }
    const v = validateEmailDomain(d);
    if (!v.ok) {
      return NextResponse.json({ error: `invalid-domain:${v.reason}`, value: d }, { status: 400 });
    }
    if (!emailDomains.includes(v.domain)) emailDomains.push(v.domain);
  }

  const defaultRole =
    body.defaultRole === 'OWNER' || body.defaultRole === 'ADMIN' || body.defaultRole === 'MEMBER'
      ? (body.defaultRole as OrgRole)
      : OrgRole.MEMBER;

  // 特定协议的验证
  if (protocol === SsoProtocol.SAML) {
    if (typeof body.samlMetadata !== 'string' || !body.samlMetadata.includes('<')) {
      return NextResponse.json({ error: 'saml-metadata-required' }, { status: 400 });
    }
  } else {
    // OIDC
    if (
      typeof body.oidcIssuer !== 'string' ||
      typeof body.oidcClientId !== 'string' ||
      typeof body.oidcClientSecret !== 'string' ||
      body.oidcClientSecret.length === 0
    ) {
      return NextResponse.json({ error: 'oidc-fields-required' }, { status: 400 });
    }
    try {
      new URL(body.oidcIssuer);
    } catch {
      return NextResponse.json({ error: 'invalid-oidc-issuer' }, { status: 400 });
    }
  }

  // 两步写入：先插入以分配行 id，然后用 HKDF 派生的 OIDC 客户端密钥密文更新
  // （模式与 RFC 0003 PR-2 相同）。
  let created;
  try {
    created = await prisma.identityProvider.create({
      data: {
        orgId: gate.orgId,
        protocol,
        name: body.name.slice(0, 120),
        emailDomains,
        defaultRole,
        enforceForLogin,
        samlMetadata: protocol === SsoProtocol.SAML ? (body.samlMetadata as string) : null,
        oidcIssuer: protocol === SsoProtocol.OIDC ? (body.oidcIssuer as string) : null,
        oidcClientId: protocol === SsoProtocol.OIDC ? (body.oidcClientId as string) : null,
      },
      select: {
        id: true,
        name: true,
        protocol: true,
        emailDomains: true,
        defaultRole: true,
        enforceForLogin: true,
        enabledAt: true,
        scimEnabled: true,
        scimTokenPrefix: true,
        oidcIssuer: true,
        oidcClientId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  } catch (err) {
    // 最可能是 @@unique([orgId, protocol]) 唯一约束违规。
    return NextResponse.json(
      { error: 'protocol-already-exists', message: (err as Error).message.slice(0, 200) },
      { status: 409 },
    );
  }

  if (protocol === SsoProtocol.OIDC) {
    await prisma.identityProvider.update({
      where: { id: created.id },
      data: {
        oidcClientSecret: encryptOidcSecret(created.id, body.oidcClientSecret as string),
      },
    });
  }

  return NextResponse.json(
    {
      data: {
        id: created.id,
        name: created.name,
        protocol: created.protocol,
        emailDomains: created.emailDomains,
        defaultRole: created.defaultRole,
        enforceForLogin: created.enforceForLogin,
        enabledAt: created.enabledAt?.toISOString() ?? null,
        scimEnabled: created.scimEnabled,
        scimTokenPrefix: created.scimTokenPrefix,
        oidcIssuer: created.oidcIssuer,
        oidcClientId: created.oidcClientId,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
      },
    },
    { status: 201, headers: rateHeaders(remaining, reset) },
  );
}

// ─── 共享帮助函数 ─────────────────────────────────────────────────────────

function errorCode(status: number): string {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  return 'error';
}

function rateLimited(reset: number) {
  return NextResponse.json(
    { error: 'rate-limited' },
    {
      status: 429,
      headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(reset) },
    },
  );
}

function rateHeaders(remaining: number, reset: number): Record<string, string> {
  return {
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(reset),
  };
}
