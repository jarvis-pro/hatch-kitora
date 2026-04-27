import { Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

interface Props {
  /** 收件人的显示名称（如果我们没有，默认为 "there"）。 */
  name?: string;
  appUrl?: string;
  /** 刚刚被自动禁用的端点 URL。 */
  endpointUrl: string;
  /** 端点所在的组织的 slug — 用于深层链接。 */
  orgSlug: string;
  /** 端点 id — 用于深层链接。 */
  endpointId: string;
  /** 触发自动禁用的连续失败次数（信息性）。 */
  consecutiveFailures: number;
}

/**
 * RFC 0003 PR-4 — 每当 cron 工作线程触发端点的自动禁用阈值时，
 * 发送给组织的 OWNER + ADMIN（默认：8 次连续失败，≈ 2 天的尝试）。
 *
 * 语气：可操作的，而不是耸人听闻的 — 端点已暂停，未删除，
 * 接收团队通常只需要修复其服务并重新启用。
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
