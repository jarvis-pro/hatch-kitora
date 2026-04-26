'use server';

import { OrgRole } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { requireActiveOrg, requireUser } from '@/lib/auth/session';
import { expiresAt, generateRawToken, hashToken } from '@/lib/auth/tokens';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { currentRegion } from '@/lib/region';

import { sendInvitationEmail } from './email-flows';
import { can } from './permissions';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const createSchema = z.object({
  email: z.string().email().toLowerCase(),
  role: z.nativeEnum(OrgRole),
});

const revokeSchema = z.object({ invitationId: z.string().min(1) });
const acceptSchema = z.object({ token: z.string().min(20).max(128) });

/**
 * ADMIN/OWNER: invite a new member to the active org.
 *
 * Re-issuing an invitation to the same email replaces any pending row (we
 * can't keep two pending tokens for the same (orgId,email) under our unique
 * constraint, and re-sending should always be valid).
 */
export async function createInvitationAction(input: z.infer<typeof createSchema>) {
  const me = await requireActiveOrg();
  if (!can(me.role, 'member.invite')) {
    return { ok: false as const, error: 'forbidden' as const };
  }
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }
  // OWNER role is reserved for the founding member; transfer is a separate flow.
  if (parsed.data.role === OrgRole.OWNER) {
    return { ok: false as const, error: 'cannot-invite-owner' as const };
  }

  const email = parsed.data.email;

  // Don't bother inviting someone already in this org.
  const existingMember = await prisma.user.findFirst({
    where: {
      email,
      memberships: { some: { orgId: me.orgId } },
    },
    select: { id: true },
  });
  if (existingMember) {
    return { ok: false as const, error: 'already-member' as const };
  }

  // RFC 0005 §5 — cross-region invites are forbidden. If a User row with
  // this email exists in another region, refuse to issue an invitation
  // that they could never legitimately accept (the accept flow is also
  // region-scoped). When no User row exists yet the invitation is fine —
  // the recipient will sign up in this region first.
  const region = currentRegion();
  const wrongRegionMatch = await prisma.user.findFirst({
    where: { email, region: { not: region } },
    select: { id: true, region: true },
  });
  if (wrongRegionMatch) {
    logger.info(
      { orgId: me.orgId, email, expectedRegion: region, foundRegion: wrongRegionMatch.region },
      'invite-cross-region-blocked',
    );
    return { ok: false as const, error: 'cross-region' as const };
  }

  const raw = generateRawToken();
  const tokenHash = hashToken(raw);
  const expires = expiresAt(INVITE_TTL_MS);

  // Replace any prior invitation for the same (org,email) — keeps the unique
  // constraint clean and means re-sends always work.
  await prisma.$transaction([
    prisma.invitation.deleteMany({ where: { orgId: me.orgId, email } }),
    prisma.invitation.create({
      data: {
        orgId: me.orgId,
        email,
        role: parsed.data.role,
        tokenHash,
        expiresAt: expires,
        invitedBy: me.userId,
      },
    }),
  ]);

  const [org, inviter] = await Promise.all([
    prisma.organization.findUniqueOrThrow({
      where: { id: me.orgId },
      select: { name: true },
    }),
    prisma.user.findUnique({
      where: { id: me.userId },
      select: { name: true, email: true },
    }),
  ]);

  try {
    await sendInvitationEmail({
      to: email,
      orgName: org.name,
      inviterName: inviter?.name ?? inviter?.email ?? null,
      role: parsed.data.role,
      raw,
    });
  } catch (err) {
    // Email failure is non-fatal — admins can re-send from the members page.
    logger.error({ err, orgId: me.orgId, email }, 'invitation-email-failed-non-fatal');
  }

  await recordAudit({
    actorId: me.userId,
    orgId: me.orgId,
    action: 'member.invited',
    target: email,
    metadata: { role: parsed.data.role },
  });

  revalidatePath('/settings/members');
  return { ok: true as const };
}

export async function revokeInvitationAction(input: z.infer<typeof revokeSchema>) {
  const me = await requireActiveOrg();
  if (!can(me.role, 'member.invite')) {
    return { ok: false as const, error: 'forbidden' as const };
  }
  const parsed = revokeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const result = await prisma.invitation.updateMany({
    where: {
      id: parsed.data.invitationId,
      orgId: me.orgId,
      acceptedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) {
    return { ok: false as const, error: 'not-found' as const };
  }

  revalidatePath('/settings/members');
  return { ok: true as const };
}

/**
 * Token-bearer accepts the invitation. Caller must already be authenticated
 * with the email the invitation was sent to.
 */
export async function acceptInvitationAction(input: z.infer<typeof acceptSchema>) {
  const sessionUser = await requireUser();
  const parsed = acceptSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid' as const };
  }

  const tokenHash = hashToken(parsed.data.token);
  const inv = await prisma.invitation.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      orgId: true,
      email: true,
      role: true,
      acceptedAt: true,
      revokedAt: true,
      expiresAt: true,
      organization: { select: { region: true } },
    },
  });
  if (!inv || inv.acceptedAt || inv.revokedAt) {
    return { ok: false as const, error: 'invalid' as const };
  }
  if (inv.expiresAt.getTime() < Date.now()) {
    return { ok: false as const, error: 'expired' as const };
  }
  // RFC 0005 §5 — invitations are region-bound. Cross-region tokens
  // shouldn't exist (the create path blocks them) and same-stack DBs
  // can't store cross-region rows, but as belt-and-braces we explicitly
  // reject anything pointing outside this region.
  if (inv.organization.region !== currentRegion()) {
    return { ok: false as const, error: 'cross-region' as const };
  }

  const userEmail = (sessionUser.email ?? '').toLowerCase();
  if (userEmail !== inv.email.toLowerCase()) {
    return {
      ok: false as const,
      error: 'wrong-email' as const,
      expectedEmail: inv.email,
    };
  }

  const userId = sessionUser.id as string;

  await prisma.$transaction([
    prisma.membership.upsert({
      where: { orgId_userId: { orgId: inv.orgId, userId } },
      create: { orgId: inv.orgId, userId, role: inv.role },
      // Re-accepting an old invite shouldn't downgrade an existing role.
      update: {},
    }),
    prisma.invitation.update({
      where: { id: inv.id },
      data: { acceptedAt: new Date() },
    }),
  ]);

  await recordAudit({
    actorId: userId,
    orgId: inv.orgId,
    action: 'member.joined',
    metadata: { role: inv.role },
  });

  const org = await prisma.organization.findUnique({
    where: { id: inv.orgId },
    select: { slug: true },
  });
  return { ok: true as const, slug: org?.slug ?? null };
}
