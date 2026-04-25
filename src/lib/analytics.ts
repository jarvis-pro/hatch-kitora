/**
 * Provider-agnostic analytics abstraction.
 *
 * Wire up your provider (PostHog / Plausible / GA / Segment / Vercel Analytics)
 * inside `track`. The rest of the app calls `track('event_name', props)`
 * regardless of which backend is configured.
 */

import { env } from '@/env';

export type AnalyticsEvent =
  | { name: 'user.signed_up'; properties: { method: 'credentials' | 'oauth'; provider?: string } }
  | { name: 'user.signed_in'; properties: { method: 'credentials' | 'oauth'; provider?: string } }
  | { name: 'subscription.checkout_started'; properties: { plan: string } }
  | { name: 'subscription.activated'; properties: { plan: string } }
  | { name: 'subscription.canceled'; properties: { plan: string } };

interface TrackContext {
  userId?: string;
  ip?: string;
  userAgent?: string;
}

export function track<E extends AnalyticsEvent>(
  event: E['name'],
  properties: Extract<AnalyticsEvent, { name: E['name'] }>['properties'],
  context: TrackContext = {},
): void {
  // No-op when no analytics provider is configured.
  if (!env.NEXT_PUBLIC_ANALYTICS_ID) {
    return;
  }

  // TODO: forward to your provider of choice.
  // Example (PostHog):
  // posthog.capture(event, { ...properties, ...context });
  // Example (Plausible):
  // plausible(event, { props: properties });
  void event;
  void properties;
  void context;
}
