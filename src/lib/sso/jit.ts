// NOTE: deliberately *not* `'server-only'` here — the SSO callback route
// (server-side) and the e2e suite both consume this. Transitive `@/lib/db`
// is Node-only, so accidental client bundling fails loud anyway.
//
// Just-in-time user / membership provisioning. Called from the SSO ACS
// callback after Jackson validates the SAML response and we have a stable
// `(providerId, providerSubject, email)` triple.
//
// Resolution priority:
//
//   1. `(providerId, providerSubject)` — the strongest binding; survives
//      email rotation by the IdP.
//   2. `email` — the fallback for first login (no membership row carries a
//      providerSubject yet) and for organic users who already had a Kitora
//      account before the org enabled SSO.
//   3. neither — create a fresh User + Membership at the IdP's `defaultRole`.

import type { OrgRole } from '@prisma/client';

import { recordAudit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { currentRegion } from '@/lib/region';

export interface JitInput {
  /** IdP row id (from `IdentityProvider`). */
  providerId: string;
  /** SAML NameID or OIDC `sub` — stable across the same IdP. */
  providerSubject: string;
  /** Email asserted by the IdP. We trust the IdP's verification. */
  email: string;
  /** Optional display name from IdP claims. */
  name?: string | null;
  /** Org id the IdP belongs to. */
  orgId: string;
  /** `IdentityProvider.defaultRole` for new memberships. */
  defaultRole: OrgRole;
}

export interface JitResult {
  userId: string;
  /** True if we created the User row in this call. */
  userCreated: boolean;
  /** True if we created (or restored) the Membership row in this call. */
  membershipCreated: boolean;
}

export async function provisionSsoUser(input: JitInput): Promise<JitResult> {
  // Fast path: re-login by an already-bound SSO membership.
  const bound = await prisma.membership.findFirst({
    where: { providerId: input.providerId, providerSubject: input.providerSubject },
    select: { userId: true, deletedAt: true, orgId: true, id: true },
  });
  if (bound) {
    if (bound.deletedAt) {
      // SCIM had previously soft-deleted this row. Reactivate on a fresh
      // SSO login — IT clearly didn't mean for the user to be locked out
      // since they're still in the IdP's app assignments.
      await prisma.membership.update({
        where: { id: bound.id },
        data: { deletedAt: null },
      });
    }
    return { userId: bound.userId, userCreated: false, membershipCreated: false };
  }

  // Path B: existing User row by email, but no SSO binding yet.
  // RFC 0005 — SSO is region-bound: the IdP belongs to an Org that lives
  // in this stack's region (the SSO start handler enforces this), so the
  // matching legacy account must too. The composite (email, region) key
  // returns the right row without ambiguity.
  const region = currentRegion();
  const existingUser = await prisma.user.findUnique({
    where: { email_region: { email: input.email.toLowerCase(), region } },
    select: { id: true },
  });
  if (existingUser) {
    // Upsert their membership in the SSO org, attaching the provider binding.
    const result = await prisma.membership.upsert({
      where: { orgId_userId: { orgId: input.orgId, userId: existingUser.id } },
      create: {
        orgId: input.orgId,
        userId: existingUser.id,
        role: input.defaultRole,
        providerId: input.providerId,
        providerSubject: input.providerSubject,
      },
      update: {
        // Don't downgrade an existing role — only attach the SSO binding.
        providerId: input.providerId,
        providerSubject: input.providerSubject,
        deletedAt: null,
      },
      select: { id: true },
    });
    logger.info(
      { userId: existingUser.id, providerId: input.providerId },
      'sso-bound-existing-user',
    );
    return { userId: existingUser.id, userCreated: false, membershipCreated: !!result };
  }

  // Path C: brand-new user. We trust IdP-asserted email and stamp
  // `emailVerified` immediately — going through SSO satisfies the same
  // "they own this inbox" promise as our magic link.
  const created = await prisma.user.create({
    data: {
      email: input.email.toLowerCase(),
      name: input.name ?? null,
      emailVerified: new Date(),
      // RFC 0005 — JIT-created users live in the same region as the
      // process. The IdP is region-bound (its parent Org carries
      // `region`), so this is the only correct value.
      region,
      memberships: {
        create: {
          orgId: input.orgId,
          role: input.defaultRole,
          providerId: input.providerId,
          providerSubject: input.providerSubject,
        },
      },
    },
    select: { id: true },
  });

  await recordAudit({
    actorId: null, // system action — IdP authoritative
    orgId: input.orgId,
    action: 'sso.jit_user_created',
    target: created.id,
    metadata: {
      providerId: input.providerId,
      email: input.email.toLowerCase(),
    },
  });

  return { userId: created.id, userCreated: true, membershipCreated: true };
}
