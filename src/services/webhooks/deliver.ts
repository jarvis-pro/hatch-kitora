// 注意：这里故意*不*是 `'server-only'` ——Playwright 的 e2e 套件
// 对本地 http 接收器驱动 `deliverWebhook` 以验证签名
// 和重试行为。传递的 `@/lib/logger`（pino）dep 本身
// 由 env 加载的配置把守，所以即使没有显式标记，
// 意外的客户端捆绑仍然会失败。
import { logger } from '@/lib/logger';

import { isPermanentFailure, nextRetryDelayMs } from './retry';
import { signWebhookPayload } from './sign';

/**
 * RFC 0003 PR-2 — 单一交付执行器。由 cron worker 在声明行后调用。
 * 纯函数输入/输出，以便测试可以在不触及 DB 的情况下
 * 对其进行本地 http 服务器的测试。
 *
 * 返回 cron 要写回的下一状态描述符。永远不会抛出——fetch 错误 / 超时
 * 被映射到 RETRYING 加上 5xx 替代状态，以便重试曲线仍然适用。
 */

const FETCH_TIMEOUT_MS = 10_000;

interface DeliverInput {
  url: string;
  secret: string;
  eventId: string;
  eventType: string;
  /** 完整事件信封（来自 `enqueueWebhook` 的 { id, type, createdAt, data } 形状）。*/
  payload: object;
  /** 1-based 尝试号，用于*这*次尝试。*/
  attempt: number;
}

export type DeliverOutcome =
  | {
      kind: 'delivered';
      responseStatus: number;
      responseBody: string | null;
    }
  | {
      kind: 'retry';
      responseStatus: number | null;
      responseBody: string | null;
      errorMessage: string | null;
      delayMs: number;
    }
  | {
      kind: 'dead-letter';
      responseStatus: number | null;
      responseBody: string | null;
      errorMessage: string | null;
    };

export async function deliverWebhook(input: DeliverInput): Promise<DeliverOutcome> {
  const body = JSON.stringify(input.payload);
  const { signature, timestamp } = signWebhookPayload({ secret: input.secret, body });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let errorMessage: string | null = null;

  try {
    const res = await fetch(input.url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Kitora-Webhooks/1.0',
        'X-Kitora-Event-Id': input.eventId,
        'X-Kitora-Event-Type': input.eventType,
        'X-Kitora-Timestamp': String(timestamp),
        'X-Kitora-Signature': signature,
      },
      body,
    });
    responseStatus = res.status;
    // 将存储的 body 上限设为 8KB 以保持表大小有界；接收器
    // 有时在 5xx 页面上回显大量 HTML。
    responseBody = await captureBody(res);

    if (res.ok) {
      return { kind: 'delivered', responseStatus, responseBody };
    }
    if (isPermanentFailure(res.status)) {
      return {
        kind: 'dead-letter',
        responseStatus,
        responseBody,
        errorMessage: `HTTP ${res.status}`,
      };
    }
    // 瞬间故障 → 调度下一次重试
    const delayMs = nextRetryDelayMs(input.attempt);
    if (delayMs === null) {
      return {
        kind: 'dead-letter',
        responseStatus,
        responseBody,
        errorMessage: `HTTP ${res.status}`,
      };
    }
    return {
      kind: 'retry',
      responseStatus,
      responseBody,
      errorMessage: `HTTP ${res.status}`,
      delayMs,
    };
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : 'fetch-failed';
    logger.warn({ err, url: input.url, attempt: input.attempt }, 'webhook-deliver-network-error');
    const delayMs = nextRetryDelayMs(input.attempt);
    if (delayMs === null) {
      return { kind: 'dead-letter', responseStatus, responseBody, errorMessage };
    }
    return { kind: 'retry', responseStatus, responseBody, errorMessage, delayMs };
  } finally {
    clearTimeout(timer);
  }
}

const RESPONSE_BODY_CAP = 8 * 1024;

async function captureBody(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    return text.length > RESPONSE_BODY_CAP ? `${text.slice(0, RESPONSE_BODY_CAP)}…` : text;
  } catch {
    return null;
  }
}
