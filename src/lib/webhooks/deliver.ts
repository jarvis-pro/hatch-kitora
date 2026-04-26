// NOTE: deliberately *not* `'server-only'` here — Playwright's e2e suite
// drives `deliverWebhook` against a local http receiver to verify signing
// and retry behavior. The transitive `@/lib/logger` (pino) dep is itself
// gated by env-loaded config, so accidental client bundling still fails
// loudly even without the explicit marker.
import { logger } from '@/lib/logger';

import { isPermanentFailure, nextRetryDelayMs } from './retry';
import { signWebhookPayload } from './sign';

/**
 * RFC 0003 PR-2 — single-delivery executor. Called by the cron worker
 * once it's claimed a row. Pure-function in/out so tests can exercise it
 * against a local http server without touching the DB.
 *
 * Returns the next-state descriptor for the cron to write back. Never
 * throws — fetch errors / timeouts are mapped to RETRYING with a 5xx
 * surrogate status so the retry curve still applies.
 */

const FETCH_TIMEOUT_MS = 10_000;

interface DeliverInput {
  url: string;
  secret: string;
  eventId: string;
  eventType: string;
  /** The full event envelope ({ id, type, createdAt, data } shape from `enqueueWebhook`). */
  payload: object;
  /** 1-based attempt number for *this* try. */
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
    // Cap the stored body at 8KB to keep the table size bounded; receivers
    // sometimes echo huge HTML on 5xx pages.
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
    // transient → schedule next retry
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
