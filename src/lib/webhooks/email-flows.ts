// NOTE: deliberately *not* `'server-only'` here — `runWebhookCronTick`
// (e2e + tsx CLI both) transitively pulls this in. The `@/env` + `resend`
// imports are themselves Node-only, so accidental client bundling still
// fails loudly.
import { env } from '@/env';
import WebhookAutoDisabledEmail from '@/emails/webhook-auto-disabled';
import { sendEmail } from '@/lib/email/send';
import { logger } from '@/lib/logger';

interface SendAutoDisabledInput {
  to: string;
  /** Recipient display name — best-effort. */
  name?: string | null;
  endpointUrl: string;
  endpointId: string;
  orgSlug: string;
  consecutiveFailures: number;
}

/**
 * RFC 0003 PR-4 — fire-and-forget OWNER/ADMIN notification when the cron
 * trips an endpoint's auto-disable threshold. We don't propagate the error
 * because the auto-disable itself has already committed; a flaky mail
 * provider shouldn't undo that.
 */
export async function sendWebhookAutoDisabledEmail(input: SendAutoDisabledInput): Promise<void> {
  try {
    await sendEmail({
      to: input.to,
      subject: `Webhook paused: ${input.endpointUrl}`,
      react: WebhookAutoDisabledEmail({
        name: input.name ?? undefined,
        appUrl: env.NEXT_PUBLIC_APP_URL,
        endpointUrl: input.endpointUrl,
        orgSlug: input.orgSlug,
        endpointId: input.endpointId,
        consecutiveFailures: input.consecutiveFailures,
      }),
    });
  } catch (err) {
    logger.error(
      { err, to: input.to, endpointId: input.endpointId },
      'webhook-auto-disabled-email-failed',
    );
  }
}
