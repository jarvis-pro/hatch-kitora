// NOTE: deliberately *not* `'server-only'` here — `bridgeAuditToWebhook`
// imports this and is itself reachable from `recordAudit`, which the e2e
// suite drives via `provisionSsoUser`. The transitive `@/lib/db` (prisma)
// dependency keeps client bundling honest.
import { randomBytes } from 'node:crypto';

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

import type { WebhookEventType } from './events';

/** Event id format: `evt_<22-char base64url>` — same taste as our other ids. */
function generateEventId(): string {
  return `evt_${randomBytes(16).toString('base64url')}`;
}

/**
 * RFC 0003 PR-1 — enqueue an event for delivery to every endpoint in the
 * org that has it on its `enabledEvents` whitelist.
 *
 * In PR-1 this is wired but **not yet called from business code** — PR-2
 * connects it to Stripe webhook handler / membership actions / recordAudit.
 * Decoupling the helper lets us test the row-creation invariants in
 * isolation before plumbing it into the hot paths.
 *
 * Fan-out semantics:
 *   - One call → one logical `eventId` (cuid)
 *   - N matching endpoints → N `WebhookDelivery` rows, all sharing that
 *     eventId. Receivers can dedupe on the `X-Kitora-Event-Id` header.
 *   - Endpoints with `disabledAt != null` are skipped.
 *   - No matching endpoints → no-op (cheap; one indexed SELECT).
 *
 * Wraps in try/catch and logs because business code calls this fire-and-
 * forget — a webhook bookkeeping failure must not break Stripe webhook
 * processing or member changes.
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
        // Deliver immediately on first cron tick.
        nextAttemptAt: new Date(),
      })),
    });

    return { eventId, deliveryCount: result.count };
  } catch (err) {
    logger.error({ err, orgId, eventType }, 'webhook-enqueue-failed');
    return null;
  }
}
