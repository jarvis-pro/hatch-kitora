// NOTE: deliberately *not* `'server-only'` here — Playwright e2e tests and
// tsx CLI scripts both transitively import this via `runWebhookCronTick`
// (and various account flows). The transitive `resend` SDK + `@/env` deps
// are Node-only, so accidental client bundling still fails loudly.
import { render } from '@react-email/components';

import { env } from '@/env';
import { logger } from '@/lib/logger';

import { getResend } from './client';

interface SendEmailParams {
  to: string | string[];
  subject: string;
  react: React.ReactElement;
  replyTo?: string;
}

export async function sendEmail({ to, subject, react, replyTo }: SendEmailParams) {
  const resend = getResend();
  const html = await render(react);
  const text = await render(react, { plainText: true });

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
