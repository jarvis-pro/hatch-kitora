'use server';

import { OrgRole } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { requireActiveOrg, requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

const toggleSchema = z.object({
  orgSlug: z.string().min(1).max(80),
  require2fa: z.boolean(),
});

/**
 * RFC 0002 PR-4 — toggle the org-wide "require 2FA for all members" switch.
 *
 * Constraints:
 *   1. Caller must be OWNER of the named org.
 *   2. Caller must have 2FA enabled themselves before turning it on, or
 *      they'd lock themselves out on the next request (middleware would
 *      bounce them to /onboarding/2fa-required, but they couldn't toggle
 *      it back from there because they'd fail the same gate).
 *
 * The toggle is *not* retroactive — existing members who don't have 2FA
 * are bumped to the onboarding page on their next request, but their
 * current pages keep working until then. New invitations carry a hint in
 * the email so they know to expect the requirement at sign-in.
 */
export async function toggleOrgRequire2faAction(input: z.infer<typeof toggleSchema>) {
  const me = await requireUser();
  const parsed = toggleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const membership = await prisma.membership.findFirst({
    where: {
      userId: me.id,
      organization: { slug: parsed.data.orgSlug },
      role: OrgRole.OWNER,
    },
    select: { orgId: true },
  });
  if (!membership) {
    return { ok: false as const, error: 'forbidden' as const };
  }

  // Only check the caller's own 2FA when *enabling* — disabling never
  // locks anyone out.
  if (parsed.data.require2fa) {
    const fresh = await prisma.user.findUniqueOrThrow({
      where: { id: me.id },
      select: { twoFactorEnabled: true },
    });
    if (!fresh.twoFactorEnabled) {
      return { ok: false as const, error: 'caller-needs-2fa' as const };
    }
  }

  await prisma.organization.update({
    where: { id: membership.orgId },
    data: { require2fa: parsed.data.require2fa },
  });
  await recordAudit({
    actorId: me.id,
    orgId: membership.orgId,
    action: 'org.2fa_required_changed',
    target: membership.orgId,
    metadata: { require2fa: parsed.data.require2fa },
  });
  logger.info(
    { actor: me.id, orgId: membership.orgId, require2fa: parsed.data.require2fa },
    'org-2fa-required-changed',
  );

  revalidatePath('/settings/organization');
  return { ok: true as const };
}

/**
 * RFC 0002 PR-4 — call from RSC pages / server actions that resolve an
 * active org to enforce the require2fa policy. Returns null when compliant,
 * or an "violation" descriptor that the caller should redirect to the
 * onboarding page with. We don't throw because RSC handlers like to handle
 * this with their own redirect helpers (and `redirect()` from `next/navigation`
 * throws a special token that's awkward to chain through).
 */
export async function checkOrg2faCompliance(): Promise<null | {
  violation: 'need-2fa';
  orgSlug: string;
}> {
  const me = await requireActiveOrg();
  const [org, user] = await Promise.all([
    prisma.organization.findUniqueOrThrow({
      where: { id: me.orgId },
      select: { slug: true, require2fa: true },
    }),
    prisma.user.findUniqueOrThrow({
      where: { id: me.userId },
      select: { twoFactorEnabled: true },
    }),
  ]);
  if (org.require2fa && !user.twoFactorEnabled) {
    return { violation: 'need-2fa', orgSlug: org.slug };
  }
  return null;
}
