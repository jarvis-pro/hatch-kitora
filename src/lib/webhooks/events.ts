/**
 * RFC 0003 PR-1 — 规范事件类型注册表。
 *
 * 纯模块（没有 `'server-only'`），以便 OpenAPI spec 生成器和测试
 * 都可以导入列表。添加事件 = 在此处追加 + JSDoc
 * 有效载荷草图 + 在 PR-3 中的 `openapi/v1.yaml` 下提升规范。
 */

export const WEBHOOK_EVENTS = [
  // ── 计费 ──────────────────────────────────────────────────────────
  /** Stripe `customer.subscription.created` 镜像——组织的第一个付费订阅。*/
  'subscription.created',
  /** 计划 / 数量 / 状态更改。与 AuditLog `billing.subscription_changed` 一起触发。*/
  'subscription.updated',
  /** 订阅已终止（立即或期末）。*/
  'subscription.canceled',
  // ── 成员资格 ───────────────────────────────────────────────────────
  /** 创建新的 `Membership` 行——通常通过接受邀请。*/
  'member.added',
  /** 成员资格行已删除——通过移除或成员离开。*/
  'member.removed',
  /** 现有成员资格的 `role` 已更改（例如 MEMBER → ADMIN）。*/
  'member.role_changed',
  // ── 审计 catch-all ──────────────────────────────────────────────────
  /**
   * 在每个 `recordAudit()` 调用旁触发（受端点的
   * `enabledEvents` 白名单限制）。让集成商对我们
   * 还没有提升为一流事件的操作做出反应。
   */
  'audit.recorded',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

/** 设置形式以在 API 边界处进行 O(1) `is-known-event` 检查。*/
export const WEBHOOK_EVENTS_SET: ReadonlySet<string> = new Set(WEBHOOK_EVENTS);
