// NOTE: deliberately *not* `'server-only'` here — Playwright e2e tests and
// tsx CLI scripts both transitively import this via `runWebhookCronTick`
// (and various account flows). The transitive `resend` / `@alicloud/*`
// SDKs and `@/env` deps are Node-only, so accidental client bundling
// still fails loudly.
import { render } from '@react-email/components';

import { env } from '@/env';
import { logger } from '@/lib/logger';
import { isCnRegion } from '@/lib/region';

import { sendAliyunDirectMail } from './aliyun-direct-mail';
import { getResend } from './client';

interface SendEmailParams {
  to: string | string[];
  subject: string;
  react: React.ReactElement;
  replyTo?: string;
}

/**
 * Send a transactional email. Provider is picked by deploy region:
 *   * GLOBAL / EU → Resend (existing behaviour, RFC 0002+).
 *   * CN          → Aliyun DirectMail (RFC 0006 PR-2). `replyTo` is
 *                    silently ignored for CN — DirectMail only allows
 *                    `replyTo` as a *verified DM sender address*, so
 *                    arbitrary RFC 5322 reply-to is impossible without
 *                    pre-verifying every address. Acceptable trade-off
 *                    for v1 (only password-reset flow uses replyTo, and
 *                    the support inbox isn't even a CN concept yet).
 */
export async function sendEmail({ to, subject, react, replyTo }: SendEmailParams) {
  const html = await render(react);
  const text = await render(react, { plainText: true });

  if (isCnRegion()) {
    try {
      const result = await sendAliyunDirectMail({ to, subject, html, text });
      // Shape the return so callers that read `result.id` against the
      // Resend response keep working. DirectMail returns `envId`; we
      // use it as a stable identifier for log correlation.
      return { id: result.envId ?? null };
    } catch (error) {
      logger.error({ err: error, to, subject }, 'email-send-exception-cn');
      throw error;
    }
  }

  const resend = getResend();

  try {
    const { data, error } = await resend.emails.send({
      from: env.EMAIL_FROM,
      to,
      subject,
      html,
      text,
      replyTo,
    });
    if (error) {
      logger.error({ err: error, to, subject }, 'email-send-failed');
      throw new Error(error.message);
    }
    return data;
  } catch (error) {
    logger.error({ err: error, to, subject }, 'email-send-exception');
    throw error;
  }
}
