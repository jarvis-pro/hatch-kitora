import { Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

/**
 * Webhook 自动禁用邮件的 Props 接口。
 * @property {string} [name="there"] - 收件人的显示名称
 * @property {string} [appUrl="https://kitora.dev"] - 应用基础 URL
 * @property {string} endpointUrl - 刚刚被自动禁用的端点 URL
 * @property {string} orgSlug - 端点所在的组织 slug（用于深层链接）
 * @property {string} endpointId - 端点 ID（用于深层链接）
 * @property {number} consecutiveFailures - 触发自动禁用的连续失败次数（信息用途）
 */
interface Props {
  name?: string;
  appUrl?: string;
  endpointUrl: string;
  orgSlug: string;
  endpointId: string;
  consecutiveFailures: number;
}

/**
 * Webhook 自动禁用邮件模板。
 *
 * 在 cron 工作线程触发 Webhook 端点自动禁用阈值时发送给组织的 OWNER + ADMIN
 * （RFC 0003 PR-4，默认：8 次连续失败，约 2 天的尝试）。
 *
 * 语气：可操作性强，而非耸人听闻 — 端点已暂停（未删除），
 * 接收团队通常只需修复其服务并重新启用即可。
 *
 * @param {Props} props - 邮件参数
 * @returns {React.ReactElement} Webhook 自动禁用邮件
 */
export default function WebhookAutoDisabledEmail({
  name = 'there',
  appUrl = 'https://kitora.dev',
  endpointUrl,
  orgSlug,
  endpointId,
  consecutiveFailures,
}: Props) {
  const detailUrl = `${appUrl}/settings/organization/webhooks/${endpointId}`;
  return (
    <EmailLayout
      preview="A webhook endpoint has been auto-disabled after repeated failures."
      heading="Webhook endpoint paused"
      footerNote={`We pause endpoints automatically after ${consecutiveFailures} consecutive failed deliveries to prevent cascading retries. Re-enabling is a single click once the receiving service is healthy again.`}
    >
      <Text className="text-base leading-6 text-zinc-700">
        Hi {name}, the webhook endpoint{' '}
        <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-sm">{endpointUrl}</code> in
        the <strong>{orgSlug}</strong> organization has just been auto-disabled — the receiver
        returned errors (or timed out) on the last {consecutiveFailures} attempts.
      </Text>
      <Section className="mt-2">
        <Text className="text-sm text-zinc-600">
          Pending deliveries are paused, not lost. Once you've fixed the receiver, re-enable the
          endpoint at{' '}
          <a href={detailUrl} className="text-zinc-900 underline">
            Settings → Organization → Webhooks
          </a>{' '}
          and any retryable rows will resume on the next cron tick.
        </Text>
      </Section>
      <Section className="mt-4">
        <Text className="text-sm text-zinc-600">
          Common causes: receiver pushed a new build that returns 5xx, downstream dependency outage,
          signature verification regression, or the receiver IP got firewalled. The delivery log on
          the detail page shows the response body Kitora captured for each attempt — usually enough
          to diagnose without re-enabling first.
        </Text>
      </Section>
    </EmailLayout>
  );
}
