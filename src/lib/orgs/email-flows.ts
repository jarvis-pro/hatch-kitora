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
  /** raw token — only known at create time, lives in the email link only */
  raw: string;
}

/**
 * Send an organization invitation. Failures are propagated so the calling
 * server action can surface them, but we don't roll the invitation row back
 * (we'd rather have a stale row that admins can re-send than block UX on a
 * flaky mail provider).
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
