import 'server-only';

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getClientIp } from '@/lib/request';

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
      },
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'audit-write-failed');
  }
}
