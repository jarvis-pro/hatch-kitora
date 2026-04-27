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
 * RFC 0002 PR-4 — 切换 org 级"要求所有成员使用 2FA"开关。
 *
 * 约束：
 *   1. 调用者必须是命名 org 的 OWNER。
 *   2. 在启用它之前，调用者必须自己启用 2FA，否则
 *      他们会在下一个请求时将自己锁定（中间件会
 *      将他们反弹到 /onboarding/2fa-required，但他们无法从那里切换
 *      它回来，因为他们会失败同样的把守）。
 *
 * 该切换*不*具有追溯效果 — 没有 2FA 的现有成员
 * 在他们的下一个请求中被提示到登录页面，但他们
 * 的当前页面在那之前仍然有效。新邀请在
 * 邮件中带有提示，所以他们知道在登录时会期望此要求。
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

  // 仅在*启用*时检查调用者自己的 2FA — 禁用永远不会
  // 将任何人锁定。
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
 * RFC 0002 PR-4 — 从解析 active org 的 RSC 页面/server action 调用
 * 以执行 require2fa 策略。当符合时返回 null，或调用者应重定向到
 * 登录页面的"violation"描述符。我们不抛出因为 RSC 处理程序喜欢用
 * 他们自己的重定向助手处理这个（而来自 `next/navigation` 的 `redirect()`
 * 抛出一个特殊 token 该 token 链接起来很尴尬）。
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
