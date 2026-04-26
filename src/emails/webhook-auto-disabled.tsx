import { Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

interface Props {
  /** Recipient's display name (defaults to "there" if we don't have one). */
  name?: string;
  appUrl?: string;
  /** Endpoint URL that just got auto-disabled. */
  endpointUrl: string;
  /** Slug of the org the endpoint lives in — for the deep link. */
  orgSlug: string;
  /** Endpoint id — used for the deep link. */
  endpointId: string;
  /** How many consecutive failures triggered the auto-disable (informational). */
  consecutiveFailures: number;
}

/**
 * RFC 0003 PR-4 — sent to OWNER + ADMIN of an org whenever the cron worker
 * trips an endpoint's auto-disable threshold (default: 8 consecutive
 * failures, ≈ 2 days of attempts).
 *
 * Tone: actionable, not alarmist — the endpoint is paused, not deleted, and
 * the receiving team usually just needs to fix their service and re-enable.
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
