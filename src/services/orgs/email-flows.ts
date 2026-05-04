import 'server-only';

import type { OrgRole } from '@prisma/client';

import { env } from '@/env';
import OrgInvitationEmail from '@/emails/org-invitation';
import { sendEmail } from '@/lib/email/send';
import { logger } from '@/lib/logger';

interface SendInvitationInput {
  to: string;
  orgName: string;
  inviterName?: string | null;
  role: OrgRole;
  /** 原始 token — 仅在创建时已知，仅存在于邮件链接中 */
  raw: string;
}

/**
 * 发送组织邀请。失败会被传播，以便调用的
 * server action 可以显示它们，但我们不会回滚邀请行
 *（我们宁愿有一个管理员可以重新发送的过期行，也不想因为
 * 不稳定的邮件提供商而阻止 UX）。
 */
export async function sendInvitationEmail(input: SendInvitationInput): Promise<void> {
  const acceptUrl = `${env.NEXT_PUBLIC_APP_URL}/invite/${input.raw}`;
  try {
    await sendEmail({
      to: input.to,
      subject: `You're invited to ${input.orgName} on Kitora`,
      react: OrgInvitationEmail({
        orgName: input.orgName,
        inviterName: input.inviterName ?? undefined,
        role: input.role,
        acceptUrl,
      }),
    });
  } catch (err) {
    logger.error({ err, to: input.to }, 'org-invitation-email-failed');
    throw err;
  }
}
