// NOTE: deliberately *not* `'server-only'` here — `recordAudit` (from
// `@/lib/audit`) imports this transitively, and the Playwright e2e suite
// reaches it via `provisionSsoUser`. Transitive `@/lib/db` (prisma) gates
// accidental client bundling.
import { enqueueWebhook } from './enqueue';
import type { WebhookEventType } from './events';

/**
 * RFC 0003 PR-2 — bridge AuditLog → outgoing webhook events.
 *
 * Two-tier mapping:
 *
 *   1. Specific audit actions promote to first-class webhook events
 *      (e.g. `member.joined` → `member.added`). The receiver gets a
 *      stable contract for the high-value cases.
 *   2. *Every* audit (with an orgId) ALSO fires `audit.recorded` so
 *      integrators can react to actions we haven't promoted yet.
 *
 * Fire-and-forget: this function never throws. Audit writes must not
 * fail if webhook bookkeeping has a hiccup.
 */

const AUDIT_TO_WEBHOOK: Record<string, WebhookEventType | null> = {
  // member events
  'member.joined': 'member.added',
  'member.removed': 'member.removed',
  'member.role_changed': 'member.role_changed',
  // billing — the stripe dispatcher fires the typed event directly with
  // a richer payload, so we explicitly suppress the audit-bridge here
  // to avoid double-fanning.
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
  if (!input.orgId) return; // platform-scoped audits never fire org webhooks

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
    // If `promoted === null`, an upstream caller is responsible for the
    // typed event; don't double-emit, but still let `audit.recorded`
    // through below since the receiver may want the audit-shape too.
  }

  // Always emit the catch-all so subscribers can react to anything we
  // record — even actions we haven't promoted (yet).
  await enqueueWebhook(input.orgId, 'audit.recorded', {
    action: input.action,
    actorId: input.actorId,
    target: input.target,
    metadata: input.metadata,
  });
}
