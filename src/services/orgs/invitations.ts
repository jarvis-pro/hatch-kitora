'use server';

import { OrgRole } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/services/audit';
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
 * ADMIN/OWNER：邀请新成员加入活跃组织。
 *
 * 重新向同一邮箱发出邀请将替换任何待处理行（在我们的唯一约束下
 * 我们不能为同一 (orgId,email) 保留两个待处理 token，重新发送
 * 应该始终有效）。
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
  // OWNER 角色保留给创始成员；转移是单独的流程。
  if (parsed.data.role === OrgRole.OWNER) {
    return { ok: false as const, error: 'cannot-invite-owner' as const };
  }

  const email = parsed.data.email;

  // 不要浪费时间邀请已经在这个 org 中的人。
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

  // RFC 0005 §5 — 禁止跨区域邀请。如果具有此邮箱的 User 行
  // 存在于另一个区域，拒绝发出邀请，他们永远无法合法接受
  //（接受流程也是区域范围的）。当尚无 User 行时邀请很好 —
  // 收件人将首先在此区域注册。
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

  // 替换同一 (org,email) 的任何先前邀请 — 保持唯一约束清洁
  // 并意味着重新发送始终有效。
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
    // 邮件失败无关痛痒 — 管理员可以从成员页面重新发送。
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
 * Token 持有者接受邀请。调用者必须已使用邀请所发送到的
 * 邮箱进行身份验证。
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
  // RFC 0005 §5 — 邀请按区域绑定。跨区域 token
  // 不应存在（创建路径阻止它们）并且相同堆栈的 DB
  // 无法存储跨区域行，但作为保险我们显式
  // 拒绝指向此区域之外的任何东西。
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
      // 重新接受旧邀请不应降级现有角色。
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
