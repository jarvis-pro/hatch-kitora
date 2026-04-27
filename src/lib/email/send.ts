// 注意：这里故意*没有* `'server-only'` — Playwright e2e 测试和
// tsx CLI 脚本都通过 `runWebhookCronTick` 和各种账户流
// 传递导入这个。传递的 `resend` / `@alicloud/*` SDK 和
// `@/env` 依赖项是 Node 专用，所以意外的客户端打包
// 仍会大声失败。
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
 * 发送事务性电子邮件。提供商由部署区域选择：
 *   * GLOBAL / EU → Resend（现有行为，RFC 0002+）。
 *   * CN          → 阿里云 DirectMail（RFC 0006 PR-2）。`replyTo` 对
 *                    CN 被无声忽略 — DirectMail 仅允许 `replyTo` 作为
 *                    *已验证的 DM 发件人地址*，所以任意 RFC 5322
 *                    reply-to 不可能而不预先验证每个地址。可接受的
 *                    v1 权衡（仅密码重置流使用 replyTo，并且
 *                    支持收件箱甚至还不是 CN 概念）。
 */
export async function sendEmail({ to, subject, react, replyTo }: SendEmailParams) {
  const html = await render(react);
  const text = await render(react, { plainText: true });

  if (isCnRegion()) {
    try {
      const result = await sendAliyunDirectMail({ to, subject, html, text });
      // 塑形返回，以便读取 `result.id` 针对
      // Resend 响应的调用者继续工作。DirectMail 返回 `envId`；
      // 我们用它作为日志关联的稳定标识符。
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
