'use server';

import { OrgRole, SsoProtocol } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { validateEmailDomain } from '@/lib/sso/domain';
import { encryptOidcSecret, generateScimToken } from '@/lib/sso/secret';

/**
 * RFC 0004 PR-1 — IdentityProvider CRUD + SCIM token lifecycle.
 *
 * Authorization model:
 *
 *   - Every action resolves the org by `orgSlug` then checks membership.
 *   - OWNER / ADMIN can create / update non-`enforceForLogin` fields and
 *     manage SCIM tokens.
 *   - Only OWNER can flip `enforceForLogin = true` (locking the org behind
 *     the IdP) — that's a destructive enough decision to gate at the top
 *     role.
 *
 * Secret lifecycle:
 *
 *   - OIDC `client_secret` plaintext flows in via `create` / `update` only.
 *     We HKDF + AES-GCM it with the just-created row id as salt before
 *     persisting. To rotate, the caller resubmits the secret in another
 *     update — there's no "decrypt and show me" path.
 *   - SCIM token plaintext is returned exactly once at `rotateScimToken`.
 *     The DB keeps `scimTokenHash` + `scimTokenPrefix` for lookups + UI.
 */

const orgScopeSchema = z.object({
  orgSlug: z.string().min(1).max(80),
});

const protocolSchema = z.nativeEnum(SsoProtocol);

const baseShape = {
  name: z.string().min(1).max(120),
  emailDomains: z.array(z.string().min(1).max(253)).max(20).default([]),
  defaultRole: z.nativeEnum(OrgRole).default(OrgRole.MEMBER),
  enforceForLogin: z.boolean().default(false),
  enabledAt: z.union([z.date(), z.null()]).optional(),
};

const createSchema = orgScopeSchema.extend({
  protocol: protocolSchema,
  ...baseShape,
  // SAML — full metadata XML
  samlMetadata: z
    .string()
    .max(64 * 1024)
    .optional(),
  // OIDC
  oidcIssuer: z.string().url().max(512).optional(),
  oidcClientId: z.string().max(255).optional(),
  oidcClientSecret: z.string().max(512).optional(),
});

const updateSchema = orgScopeSchema.extend({
  id: z.string().min(1).max(64),
  name: baseShape.name.optional(),
  emailDomains: baseShape.emailDomains.optional(),
  defaultRole: baseShape.defaultRole.optional(),
  enforceForLogin: baseShape.enforceForLogin.optional(),
  enabledAt: baseShape.enabledAt,
  samlMetadata: z
    .string()
    .max(64 * 1024)
    .nullable()
    .optional(),
  oidcIssuer: z.string().url().max(512).nullable().optional(),
  oidcClientId: z.string().max(255).nullable().optional(),
  oidcClientSecret: z.string().max(512).optional(), // null re-encrypts only if provided
  scimEnabled: z.boolean().optional(),
});

const idScopeSchema = orgScopeSchema.extend({
  id: z.string().min(1).max(64),
});

// ─── auth helpers ───────────────────────────────────────────────────────────

interface OrgGate {
  orgId: string;
  role: OrgRole;
}

async function requireSsoManager(userId: string, orgSlug: string): Promise<OrgGate | null> {
  const membership = await prisma.membership.findFirst({
    where: {
      userId,
      organization: { slug: orgSlug },
      role: { in: [OrgRole.OWNER, OrgRole.ADMIN] },
    },
    select: { orgId: true, role: true },
  });
  return membership ? { orgId: membership.orgId, role: membership.role } : null;
}

function normalizeDomains(input: readonly string[]): string[] | { error: string; bad: string } {
  const out: string[] = [];
  for (const raw of input) {
    const verdict = validateEmailDomain(raw);
    if (!verdict.ok) {
      return { error: verdict.reason, bad: raw };
    }
    if (!out.includes(verdict.domain)) out.push(verdict.domain);
  }
  return out;
}

function assertProtocolFields(input: {
  protocol: SsoProtocol;
  samlMetadata?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
}): { ok: true } | { ok: false; reason: string } {
  if (input.protocol === SsoProtocol.SAML) {
    if (!input.samlMetadata || !input.samlMetadata.includes('<')) {
      return { ok: false, reason: 'saml-metadata-required' };
    }
    return { ok: true };
  }
  // OIDC
  if (!input.oidcIssuer || !input.oidcClientId || !input.oidcClientSecret) {
    return { ok: false, reason: 'oidc-fields-required' };
  }
  return { ok: true };
}

// ─── actions ────────────────────────────────────────────────────────────────

export type CreateIdentityProviderInput = z.input<typeof createSchema>;

interface CreateResult {
  ok: true;
  id: string;
}
interface ErrorResult {
  ok: false;
  error: string;
  message?: string;
}

export async function createIdentityProviderAction(
  input: CreateIdentityProviderInput,
): Promise<CreateResult | ErrorResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input', message: parsed.error.message };

  const me = await requireUser().catch(() => null);
  if (!me) return { ok: false, error: 'unauthorized' };

  const gate = await requireSsoManager(me.id, parsed.data.orgSlug);
  if (!gate) return { ok: false, error: 'forbidden' };

  // OWNER-only flag.
  if (parsed.data.enforceForLogin && gate.role !== OrgRole.OWNER) {
    return { ok: false, error: 'enforce-owner-only' };
  }

  const protoCheck = assertProtocolFields(parsed.data);
  if (!protoCheck.ok) return { ok: false, error: protoCheck.reason };

  const domains = normalizeDomains(parsed.data.emailDomains);
  if (!Array.isArray(domains)) {
    return { ok: false, error: `invalid-domain:${domains.error}`, message: domains.bad };
  }

  // Two-step write: insert the row to allocate the id, then encrypt the
  // OIDC secret with that id as HKDF salt. Mirrors the `WebhookEndpoint`
  // create flow (RFC 0003 PR-2).
  const created = await prisma.identityProvider.create({
    data: {
      orgId: gate.orgId,
      protocol: parsed.data.protocol,
      name: parsed.data.name,
      emailDomains: domains,
      defaultRole: parsed.data.defaultRole,
      enforceForLogin: parsed.data.enforceForLogin,
      enabledAt: parsed.data.enabledAt ?? null,
      samlMetadata: parsed.data.samlMetadata ?? null,
      oidcIssuer: parsed.data.oidcIssuer ?? null,
      oidcClientId: parsed.data.oidcClientId ?? null,
    },
    select: { id: true },
  });

  if (parsed.data.protocol === SsoProtocol.OIDC && parsed.data.oidcClientSecret) {
    await prisma.identityProvider.update({
      where: { id: created.id },
      data: {
        oidcClientSecret: encryptOidcSecret(created.id, parsed.data.oidcClientSecret),
      },
    });
  }

  await recordAudit({
    actorId: me.id,
    orgId: gate.orgId,
    action: 'sso.idp_created',
    target: created.id,
    metadata: {
      protocol: parsed.data.protocol,
      enforceForLogin: parsed.data.enforceForLogin,
      enabledAt: parsed.data.enabledAt?.toISOString() ?? null,
    },
  });

  revalidatePath(`/settings/organization/sso`);
  revalidatePath(`/${parsed.data.orgSlug}/settings/organization/sso`);
  return { ok: true, id: created.id };
}

export async function updateIdentityProviderAction(
  input: z.input<typeof updateSchema>,
): Promise<{ ok: true } | ErrorResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input', message: parsed.error.message };

  const me = await requireUser().catch(() => null);
  if (!me) return { ok: false, error: 'unauthorized' };

  const gate = await requireSsoManager(me.id, parsed.data.orgSlug);
  if (!gate) return { ok: false, error: 'forbidden' };

  // Disambiguate the row before doing role checks against `enforceForLogin`.
  const existing = await prisma.identityProvider.findFirst({
    where: { id: parsed.data.id, orgId: gate.orgId },
    select: { id: true, protocol: true, enforceForLogin: true },
  });
  if (!existing) return { ok: false, error: 'not-found' };

  // OWNER gate on the enforce flag, regardless of new vs old value (we
  // also block ADMIN from *clearing* it — same magnitude of decision).
  if (parsed.data.enforceForLogin !== undefined && gate.role !== OrgRole.OWNER) {
    return { ok: false, error: 'enforce-owner-only' };
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.defaultRole !== undefined) data.defaultRole = parsed.data.defaultRole;
  if (parsed.data.enforceForLogin !== undefined) data.enforceForLogin = parsed.data.enforceForLogin;
  if (parsed.data.enabledAt !== undefined) data.enabledAt = parsed.data.enabledAt;
  if (parsed.data.scimEnabled !== undefined) data.scimEnabled = parsed.data.scimEnabled;

  if (parsed.data.emailDomains !== undefined) {
    const domains = normalizeDomains(parsed.data.emailDomains);
    if (!Array.isArray(domains)) {
      return { ok: false, error: `invalid-domain:${domains.error}`, message: domains.bad };
    }
    data.emailDomains = domains;
  }

  if (existing.protocol === SsoProtocol.SAML) {
    if (parsed.data.samlMetadata !== undefined) {
      if (parsed.data.samlMetadata === null) {
        return { ok: false, error: 'saml-metadata-required' };
      }
      if (!parsed.data.samlMetadata.includes('<')) {
        return { ok: false, error: 'saml-metadata-required' };
      }
      data.samlMetadata = parsed.data.samlMetadata;
    }
  } else {
    // OIDC
    if (parsed.data.oidcIssuer !== undefined) data.oidcIssuer = parsed.data.oidcIssuer;
    if (parsed.data.oidcClientId !== undefined) data.oidcClientId = parsed.data.oidcClientId;
    if (parsed.data.oidcClientSecret) {
      data.oidcClientSecret = encryptOidcSecret(existing.id, parsed.data.oidcClientSecret);
    }
  }

  await prisma.identityProvider.update({
    where: { id: existing.id },
    data,
  });

  await recordAudit({
    actorId: me.id,
    orgId: gate.orgId,
    action: 'sso.idp_updated',
    target: existing.id,
    metadata: {
      changedKeys: Object.keys(data),
    },
  });

  revalidatePath(`/settings/organization/sso`);
  revalidatePath(`/${parsed.data.orgSlug}/settings/organization/sso`);
  return { ok: true };
}

export async function deleteIdentityProviderAction(
  input: z.input<typeof idScopeSchema>,
): Promise<{ ok: true } | ErrorResult> {
  const parsed = idScopeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input', message: parsed.error.message };

  const me = await requireUser().catch(() => null);
  if (!me) return { ok: false, error: 'unauthorized' };

  const gate = await requireSsoManager(me.id, parsed.data.orgSlug);
  if (!gate) return { ok: false, error: 'forbidden' };

  // Block delete while enforceForLogin is on — operator must explicitly
  // unenforce first, otherwise we lock the org out of any password fallback.
  const existing = await prisma.identityProvider.findFirst({
    where: { id: parsed.data.id, orgId: gate.orgId },
    select: { id: true, enforceForLogin: true },
  });
  if (!existing) return { ok: false, error: 'not-found' };
  if (existing.enforceForLogin) {
    return { ok: false, error: 'enforce-still-on' };
  }

  await prisma.identityProvider.delete({ where: { id: existing.id } });

  await recordAudit({
    actorId: me.id,
    orgId: gate.orgId,
    action: 'sso.idp_deleted',
    target: existing.id,
  });

  revalidatePath(`/settings/organization/sso`);
  revalidatePath(`/${parsed.data.orgSlug}/settings/organization/sso`);
  return { ok: true };
}

interface RotateScimResult {
  ok: true;
  /** Plaintext SCIM token — show to caller exactly once, then drop. */
  token: string;
  prefix: string;
}

export async function rotateScimTokenAction(
  input: z.input<typeof idScopeSchema>,
): Promise<RotateScimResult | ErrorResult> {
  const parsed = idScopeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input', message: parsed.error.message };

  const me = await requireUser().catch(() => null);
  if (!me) return { ok: false, error: 'unauthorized' };

  const gate = await requireSsoManager(me.id, parsed.data.orgSlug);
  if (!gate) return { ok: false, error: 'forbidden' };

  const existing = await prisma.identityProvider.findFirst({
    where: { id: parsed.data.id, orgId: gate.orgId },
    select: { id: true },
  });
  if (!existing) return { ok: false, error: 'not-found' };

  const fresh = generateScimToken();
  await prisma.identityProvider.update({
    where: { id: existing.id },
    data: {
      scimTokenHash: fresh.hash,
      scimTokenPrefix: fresh.prefix,
      scimEnabled: true,
    },
  });

  await recordAudit({
    actorId: me.id,
    orgId: gate.orgId,
    action: 'sso.scim_token_rotated',
    target: existing.id,
    metadata: { tokenPrefix: fresh.prefix },
  });

  logger.info({ providerId: existing.id, prefix: fresh.prefix }, 'sso-scim-token-rotated');

  revalidatePath(`/settings/organization/sso`);
  revalidatePath(`/${parsed.data.orgSlug}/settings/organization/sso`);
  return { ok: true, token: fresh.plain, prefix: fresh.prefix };
}
