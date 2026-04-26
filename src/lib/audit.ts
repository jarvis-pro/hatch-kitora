// NOTE: deliberately *not* `'server-only'` here — Playwright e2e tests
// import this transitively via `provisionSsoUser` (RFC 0004 PR-2) and
// previously through cron-driven flows. The transitive `@/lib/db` (prisma)
// + `@/lib/request` (next/headers) deps are Node-only, so accidental
// client bundling still fails loudly.
import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { currentRegion } from '@/lib/region';
import { getClientIp } from '@/lib/request';
import { bridgeAuditToWebhook } from '@/lib/webhooks/from-audit';

/** Canonical action codes — keep these stable; UI maps them to translated copy. */
export const AUDIT_ACTIONS = [
  'role.set',
  'account.password_changed',
  'account.deleted',
  'account.sign_out_everywhere',
  'billing.subscription_changed',
  'org.created',
  'org.updated',
  'org.deleted',
  'member.invited',
  'member.joined',
  'member.removed',
  'member.role_changed',
  'ownership.transferred',
  // RFC 0002 PR-1 — Active Sessions
  'session.revoked',
  // RFC 0002 PR-2 — 2FA
  '2fa.enabled',
  '2fa.disabled',
  '2fa.backup_regenerated',
  // RFC 0002 PR-3 — Data export
  'account.export_requested',
  'org.export_requested',
  // RFC 0002 PR-4 — Deletion grace period + Org 2FA enforcement
  'account.deletion_scheduled',
  'account.deletion_cancelled',
  'org.2fa_required_changed',
  // RFC 0003 PR-1 — Outbound webhooks
  'webhook.endpoint_created',
  'webhook.endpoint_updated',
  'webhook.endpoint_deleted',
  'webhook.secret_rotated',
  'webhook.endpoint_auto_disabled',
  // RFC 0004 PR-1 — SSO (SAML + OIDC + SCIM)
  'sso.idp_created',
  'sso.idp_updated',
  'sso.idp_deleted',
  'sso.scim_token_rotated',
  'sso.login_succeeded',
  'sso.login_failed',
  'sso.jit_user_created',
  'scim.user_provisioned',
  'scim.user_deprovisioned',
  // RFC 0007 PR-2 — WebAuthn / Passkey
  'webauthn.credential_added',
  'webauthn.credential_renamed',
  'webauthn.credential_removed',
  'webauthn.login_succeeded',
  'webauthn.tfa_succeeded',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * `next-intl` rejects `.` in key segments because it parses dots as nesting.
 * We keep dotted action codes for readability in the DB and translate them
 * to underscore-form only when looking up message strings.
 */
export function auditActionToI18nKey(action: string): string {
  return action.replaceAll('.', '_');
}

interface RecordAuditInput {
  actorId: string | null;
  /**
   * Organization scope for this audit row. Pass the active org for tenant-
   * scoped actions (billing changes, member updates, ...). Pass `null` for
   * platform-level actions where the actor moves across orgs (platform
   * admin role changes, system housekeeping).
   */
  orgId?: string | null;
  action: AuditAction;
  target?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Append an audit log entry. Best-effort — failures are logged but never
 * thrown, so an audit-store outage cannot block the underlying business
 * action.
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    const ip = await getClientIp();
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        orgId: input.orgId ?? null,
        action: input.action,
        target: input.target ?? null,
        metadata: input.metadata,
        ip: ip === 'unknown' ? null : ip,
        // RFC 0005 — stamp the row with the deploy region. Callers never
        // pass region in: a single process only ever serves one region,
        // so any "override" would mean the call site is wrong.
        region: currentRegion(),
      },
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'audit-write-failed');
  }

  // RFC 0003 PR-2 — fan out to subscribed webhook endpoints. Wrapped in
  // its own try so a webhook bookkeeping error never bubbles out of the
  // audit write (the audit row itself succeeded above).
  try {
    await bridgeAuditToWebhook({
      orgId: input.orgId ?? null,
      action: input.action,
      actorId: input.actorId,
      target: input.target ?? null,
      metadata: input.metadata,
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'webhook-bridge-failed');
  }
}
