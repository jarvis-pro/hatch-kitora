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
 * RFC 0004 PR-1 — `PATCH /api/v1/orgs/{slug}/identity-providers/{id}` (partial
 * update) and `DELETE`. Reading a single provider also goes here.
 *
 * PATCH body accepts any subset of:
 *   - `name`
 *   - `emailDomains`        — re-validated wholesale
 *   - `defaultRole`
 *   - `enforceForLogin`     — OWNER only
 *   - `enabledAt`           — ISO string to enable, `null` to flip back to draft
 *   - `samlMetadata`        — SAML rows only
 *   - `oidcIssuer` / `oidcClientId` / `oidcClientSecret` — OIDC rows only
 *   - `scimEnabled`         — boolean toggle
 *
 * DELETE refuses while `enforceForLogin` is on (the deletion would lock the
 * org out of password fallback if there's no other IdP).
 */

interface PatchBody {
  name?: unknown;
  emailDomains?: unknown;
  defaultRole?: unknown;
  enforceForLogin?: unknown;
  enabledAt?: unknown;
  samlMetadata?: unknown;
  oidcIssuer?: unknown;
  oidcClientId?: unknown;
  oidcClientSecret?: unknown;
  scimEnabled?: unknown;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const gate = await gateOrgApi({ request, orgSlug: slug });
  if (!gate.ok) return errResp(gate.status);

  const { success, remaining, reset } = await apiLimiter.limit(`api:${gate.principal.tokenId}`);
  if (!success) return rateLimited(reset);

  const p = await prisma.identityProvider.findFirst({
    where: { id, orgId: gate.orgId },
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
      // samlMetadata is selected here because the detail view shows it; it's
      // public-ish (cert + URL) so safe to surface to authenticated callers.
      samlMetadata: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!p) return errResp(404);

  return NextResponse.json(
    {
      data: {
        ...p,
        enabledAt: p.enabledAt?.toISOString() ?? null,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      },
    },
    { headers: rateHeaders(remaining, reset) },
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const gate = await gateOrgApi({ request, orgSlug: slug });
  if (!gate.ok) return errResp(gate.status);

  const { success, remaining, reset } = await apiLimiter.limit(`api:${gate.principal.tokenId}`);
  if (!success) return rateLimited(reset);

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }

  const existing = await prisma.identityProvider.findFirst({
    where: { id, orgId: gate.orgId },
    select: { id: true, protocol: true },
  });
  if (!existing) return errResp(404);

  // OWNER gate on enforce flag
  if (body.enforceForLogin !== undefined) {
    const callerMembership = await prisma.membership.findFirst({
      where: { userId: gate.principal.userId, orgId: gate.orgId },
      select: { role: true },
    });
    if (callerMembership?.role !== OrgRole.OWNER) {
      return NextResponse.json({ error: 'enforce-owner-only' }, { status: 403 });
    }
  }

  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return NextResponse.json({ error: 'invalid-name' }, { status: 400 });
    }
    data.name = body.name.slice(0, 120);
  }

  if (body.emailDomains !== undefined) {
    if (!Array.isArray(body.emailDomains)) {
      return NextResponse.json({ error: 'invalid-domain' }, { status: 400 });
    }
    const next: string[] = [];
    for (const d of body.emailDomains) {
      if (typeof d !== 'string') {
        return NextResponse.json({ error: 'invalid-domain' }, { status: 400 });
      }
      const v = validateEmailDomain(d);
      if (!v.ok) {
        return NextResponse.json(
          { error: `invalid-domain:${v.reason}`, value: d },
          { status: 400 },
        );
      }
      if (!next.includes(v.domain)) next.push(v.domain);
    }
    data.emailDomains = next;
  }

  if (body.defaultRole !== undefined) {
    if (
      body.defaultRole !== 'OWNER' &&
      body.defaultRole !== 'ADMIN' &&
      body.defaultRole !== 'MEMBER'
    ) {
      return NextResponse.json({ error: 'invalid-defaultRole' }, { status: 400 });
    }
    data.defaultRole = body.defaultRole;
  }

  if (body.enforceForLogin !== undefined) {
    if (typeof body.enforceForLogin !== 'boolean') {
      return NextResponse.json({ error: 'invalid-enforceForLogin' }, { status: 400 });
    }
    data.enforceForLogin = body.enforceForLogin;
  }

  if (body.enabledAt !== undefined) {
    if (body.enabledAt === null) {
      data.enabledAt = null;
    } else if (typeof body.enabledAt === 'string') {
      const d = new Date(body.enabledAt);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: 'invalid-enabledAt' }, { status: 400 });
      }
      data.enabledAt = d;
    } else {
      return NextResponse.json({ error: 'invalid-enabledAt' }, { status: 400 });
    }
  }

  if (body.scimEnabled !== undefined) {
    if (typeof body.scimEnabled !== 'boolean') {
      return NextResponse.json({ error: 'invalid-scimEnabled' }, { status: 400 });
    }
    data.scimEnabled = body.scimEnabled;
  }

  // Protocol-specific updates
  if (existing.protocol === SsoProtocol.SAML) {
    if (body.samlMetadata !== undefined) {
      if (typeof body.samlMetadata !== 'string' || !body.samlMetadata.includes('<')) {
        return NextResponse.json({ error: 'saml-metadata-required' }, { status: 400 });
      }
      data.samlMetadata = body.samlMetadata;
    }
  } else {
    if (body.oidcIssuer !== undefined) {
      if (typeof body.oidcIssuer !== 'string') {
        return NextResponse.json({ error: 'invalid-oidc-issuer' }, { status: 400 });
      }
      try {
        new URL(body.oidcIssuer);
      } catch {
        return NextResponse.json({ error: 'invalid-oidc-issuer' }, { status: 400 });
      }
      data.oidcIssuer = body.oidcIssuer;
    }
    if (body.oidcClientId !== undefined) {
      if (typeof body.oidcClientId !== 'string') {
        return NextResponse.json({ error: 'invalid-oidc-clientId' }, { status: 400 });
      }
      data.oidcClientId = body.oidcClientId;
    }
    if (body.oidcClientSecret !== undefined) {
      if (typeof body.oidcClientSecret !== 'string' || body.oidcClientSecret.length === 0) {
        return NextResponse.json({ error: 'invalid-oidc-clientSecret' }, { status: 400 });
      }
      data.oidcClientSecret = encryptOidcSecret(existing.id, body.oidcClientSecret);
    }
  }

  await prisma.identityProvider.update({ where: { id: existing.id }, data });

  return NextResponse.json({ ok: true }, { headers: rateHeaders(remaining, reset) });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const gate = await gateOrgApi({ request, orgSlug: slug });
  if (!gate.ok) return errResp(gate.status);

  const { success, remaining, reset } = await apiLimiter.limit(`api:${gate.principal.tokenId}`);
  if (!success) return rateLimited(reset);

  const existing = await prisma.identityProvider.findFirst({
    where: { id, orgId: gate.orgId },
    select: { id: true, enforceForLogin: true },
  });
  if (!existing) return errResp(404);
  if (existing.enforceForLogin) {
    return NextResponse.json({ error: 'enforce-still-on' }, { status: 409 });
  }

  await prisma.identityProvider.delete({ where: { id: existing.id } });
  return NextResponse.json({ ok: true }, { headers: rateHeaders(remaining, reset) });
}

function errResp(status: 401 | 403 | 404 | 400 | 409) {
  const map = {
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not-found',
    400: 'bad-request',
    409: 'conflict',
  } as const;
  return NextResponse.json({ error: map[status] }, { status });
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
