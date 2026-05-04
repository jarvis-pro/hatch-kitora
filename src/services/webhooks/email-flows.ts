// 注意：这里刻意 *不* 加 `'server-only'` —— `runWebhookCronTick`
// （e2e 与 tsx CLI 都会用到）会传递性地导入本文件。`@/env`、`resend`
// 这些导入本身就只能在 Node 端运行，因此就算意外被打进客户端 bundle 也会
// 立即报错，安全性仍有保障。
import { env } from '@/env';
import WebhookAutoDisabledEmail from '@/emails/webhook-auto-disabled';
import { sendEmail } from '@/lib/email/send';
import { logger } from '@/lib/logger';

/**
 * `sendWebhookAutoDisabledEmail` 的入参定义。
 */
interface SendAutoDisabledInput {
  /** 收件人邮箱地址。 */
  to: string;
  /** 收件人显示名称（尽力而为，可能为空）。 */
  name?: string | null;
  /** 被自动停用的 Webhook 端点 URL。 */
  endpointUrl: string;
  /** 端点在数据库中的主键 ID，用于跳转到详情页。 */
  endpointId: string;
  /** 端点所属组织的 slug，用于在 dashboard URL 中定位组织。 */
  orgSlug: string;
  /** 触发自动停用时的连续失败次数，用于在邮件正文中提示。 */
  consecutiveFailures: number;
}

/**
 * RFC 0003 PR-4 —— 当 cron 任务触发某个 Webhook 端点的"自动停用"阈值时，
 * 以即发即忘（fire-and-forget）的方式向 OWNER/ADMIN 发送通知邮件。
 *
 * 这里特意不向上抛出异常：自动停用本身已经写库提交，发邮件失败时
 * 不应该回滚停用结果。出错时仅记录日志方便排查。
 *
 * @param input 邮件相关输入，详见 {@link SendAutoDisabledInput}。
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
    // 邮件发送失败不影响业务流程，仅记录到日志便于事后排查
    logger.error(
      { err, to: input.to, endpointId: input.endpointId },
      'webhook-auto-disabled-email-failed',
    );
  }
}
