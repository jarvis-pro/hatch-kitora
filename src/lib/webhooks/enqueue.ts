// 注意：这里故意*不*是 `'server-only'` ——`bridgeAuditToWebhook`
// 导入此文件，并且本身可从 `recordAudit` 到达，e2e
// 套件通过 `provisionSsoUser` 驱动。传递的 `@/lib/db`（prisma）
// 依赖项保持客户端捆绑诚实。
import { randomBytes } from 'node:crypto';

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

import type { WebhookEventType } from './events';

/** 事件 ID 格式：`evt_<22-char base64url>` ——与我们其他 ID 的风格相同。*/
function generateEventId(): string {
  return `evt_${randomBytes(16).toString('base64url')}`;
}

/**
 * RFC 0003 PR-1 — 排队一个事件以交付给组织中的每个
 * 在其 `enabledEvents` 白名单中有它的端点。
 *
 * 在 PR-1 中这是有线的但**还没有从业务代码中调用**——PR-2
 * 将其连接到 Stripe webhook 处理程序 / 成员资格操作 / recordAudit。
 * 解耦助手让我们可以在将其连接到热路径之前
 * 单独测试行创建不变量。
 *
 * 扇出语义：
 *   - 一次调用 → 一个逻辑 `eventId`（cuid）
 *   - N 个匹配端点 → N 个 `WebhookDelivery` 行，
 *     都共享该 eventId。接收器可以在 `X-Kitora-Event-Id` 头上去重。
 *   - `disabledAt != null` 的端点被跳过。
 *   - 没有匹配端点 → 无操作（便宜；一次索引 SELECT）。
 *
 * 包装在 try/catch 中并记录，因为业务代码调用此"即发即忘"——
 * webhook 簿记失败不能破坏 Stripe webhook 处理或成员更改。
 */
export async function enqueueWebhook(
  orgId: string,
  eventType: WebhookEventType,
  data: object,
): Promise<{ eventId: string; deliveryCount: number } | null> {
  try {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: {
        orgId,
        disabledAt: null,
        enabledEvents: { has: eventType },
      },
      select: { id: true },
    });
    if (endpoints.length === 0) return { eventId: '', deliveryCount: 0 };

    const eventId = generateEventId();
    const event = {
      id: eventId,
      type: eventType,
      createdAt: new Date().toISOString(),
      data,
    };

    const result = await prisma.webhookDelivery.createMany({
      data: endpoints.map((e) => ({
        endpointId: e.id,
        eventId,
        eventType,
        payload: event,
        status: 'PENDING' as const,
        // 在第一个 cron tick 上立即交付。
        nextAttemptAt: new Date(),
      })),
    });

    return { eventId, deliveryCount: result.count };
  } catch (err) {
    logger.error({ err, orgId, eventType }, 'webhook-enqueue-failed');
    return null;
  }
}
