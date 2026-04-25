import 'server-only';

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
