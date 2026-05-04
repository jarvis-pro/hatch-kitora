// 注意：这里故意*不*是 `'server-only'` ——来自的 `recordAudit`
// `@/services/audit` 传递性导入这个，Playwright e2e 套件
// 通过 `provisionSsoUser` 到达它。传递的 `@/lib/db`（prisma）
// 防止意外的客户端捆绑。
import { enqueueWebhook } from './enqueue';
import type { WebhookEventType } from './events';

/**
 * RFC 0003 PR-2 — 网桥 AuditLog → 出站 webhook 事件。
 *
 * 两层映射：
 *
 *   1. 特定审计操作提升为一流 webhook 事件
 *      （例如 `member.joined` → `member.added`）。接收者
 *      获得针对高价值情况的稳定合约。
 *   2. *每个*审计（带有 orgId）也触发 `audit.recorded` 以便
 *      集成商可以对我们还没有提升的操作做出反应。
 *
 * 即发即忘：此函数永远不会抛出。如果 webhook 簿记有问题，
 * 审计写入不能失败。
 */

const AUDIT_TO_WEBHOOK: Record<string, WebhookEventType | null> = {
  // 成员事件
  'member.joined': 'member.added',
  'member.removed': 'member.removed',
  'member.role_changed': 'member.role_changed',
  // 计费 — stripe 调度器使用更丰富的有效载荷直接触发
  // 类型事件，所以我们明确在这里抑制审计网桥
  // 以避免双重扇出。
  'billing.subscription_changed': null,
};

interface BridgeInput {
  orgId: string | null;
  action: string;
  actorId: string | null;
  target: string | null;
  metadata: unknown;
}

export async function bridgeAuditToWebhook(input: BridgeInput): Promise<void> {
  if (!input.orgId) return; // 平台范围的审计永远不会触发组织 webhooks

  const promoted = AUDIT_TO_WEBHOOK[input.action];
  if (promoted !== undefined) {
    if (promoted !== null) {
      await enqueueWebhook(input.orgId, promoted, {
        action: input.action,
        target: input.target,
        actorId: input.actorId,
        metadata: input.metadata,
      });
    }
    // 如果 `promoted === null`，上游调用者负责
    // 类型事件；不要双倍发送，但仍让 `audit.recorded`
    // 通过下面，因为接收者可能也想要审计形状。
  }

  // 总是发送 catch-all，以便订阅者可以对我们
  // 记录的任何东西做出反应——即使是我们还没有提升的操作。
  await enqueueWebhook(input.orgId, 'audit.recorded', {
    action: input.action,
    actorId: input.actorId,
    target: input.target,
    metadata: input.metadata,
  });
}
