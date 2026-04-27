/**
 * 提供商无关的分析抽象。
 *
 * 在 `track` 内连接你的提供商（PostHog / Plausible / GA / Segment / Vercel Analytics）。
 * 应用的其余部分调用 `track('event_name', props)`，无论配置了哪个后端。
 */

import { env } from '@/env';

/**
 * 支持的分析事件类型。
 */
export type AnalyticsEvent =
  | { name: 'user.signed_up'; properties: { method: 'credentials' | 'oauth'; provider?: string } }
  | { name: 'user.signed_in'; properties: { method: 'credentials' | 'oauth'; provider?: string } }
  | { name: 'subscription.checkout_started'; properties: { plan: string } }
  | { name: 'subscription.activated'; properties: { plan: string } }
  | { name: 'subscription.canceled'; properties: { plan: string } };

/**
 * 事件追踪上下文。
 * @property userId - 用户 ID。
 * @property ip - 用户 IP 地址。
 * @property userAgent - 用户浏览器 User-Agent。
 */
interface TrackContext {
  userId?: string;
  ip?: string;
  userAgent?: string;
}

/**
 * 追踪分析事件。
 * @param event - 事件名称。
 * @param properties - 事件属性。
 * @param context - 追踪上下文。
 */
export function track<E extends AnalyticsEvent>(
  event: E['name'],
  properties: Extract<AnalyticsEvent, { name: E['name'] }>['properties'],
  context: TrackContext = {},
): void {
  // 未配置分析提供商时无操作。
  if (!env.NEXT_PUBLIC_ANALYTICS_ID) {
    return;
  }

  // TODO: 转发到你选择的提供商。
  // 示例（PostHog）：
  // posthog.capture(event, { ...properties, ...context });
  // 示例（Plausible）：
  // plausible(event, { props: properties });
  void event;
  void properties;
  void context;
}
