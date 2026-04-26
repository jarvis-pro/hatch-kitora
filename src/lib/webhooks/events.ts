/**
 * RFC 0003 PR-1 — canonical event-type registry.
 *
 * Pure module (no `'server-only'`) so the OpenAPI spec generator and tests
 * can both import the list. Adding an event = appending here + a JSDoc
 * payload sketch + bumping the spec under `openapi/v1.yaml` in PR-3.
 */

export const WEBHOOK_EVENTS = [
  // ── Billing ──────────────────────────────────────────────────────────
  /** Stripe `customer.subscription.created` mirror — first paid subscription on the org. */
  'subscription.created',
  /** Plan / quantity / status change. Fired alongside the AuditLog `billing.subscription_changed`. */
  'subscription.updated',
  /** Subscription terminated (immediate or end-of-period). */
  'subscription.canceled',
  // ── Membership ───────────────────────────────────────────────────────
  /** New `Membership` row created — typically via accepted invitation. */
  'member.added',
  /** Membership row deleted — by removal or by the member leaving. */
  'member.removed',
  /** Existing membership's `role` changed (e.g. MEMBER → ADMIN). */
  'member.role_changed',
  // ── Audit catch-all ──────────────────────────────────────────────────
  /**
   * Fired alongside every `recordAudit()` call (subject to the endpoint's
   * `enabledEvents` whitelist). Lets integrators react to actions we
   * haven't promoted to a first-class event yet.
   */
  'audit.recorded',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

/** Set form for O(1) `is-known-event` checks at the API boundary. */
export const WEBHOOK_EVENTS_SET: ReadonlySet<string> = new Set(WEBHOOK_EVENTS);
