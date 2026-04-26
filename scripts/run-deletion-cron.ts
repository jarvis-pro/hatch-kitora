#!/usr/bin/env tsx
/**
 * RFC 0002 PR-4 — daily deletion cron.
 *
 * Run from Vercel / Fly cron once a day:
 *   pnpm tsx scripts/run-deletion-cron.ts
 *
 * Invariant: a user is hard-deleted iff
 *   `status = PENDING_DELETION` AND `deletionScheduledAt < now()`.
 *
 * Defensive double-check before each delete:
 *   - The user must not own a non-personal multi-member org. The scheduling
 *     action enforced this at request time, but the grace window is 30
 *     days — long enough for "someone added me back as OWNER" edge cases.
 *     If we hit one, log an error and skip; ops will resolve manually.
 *
 * Audit + email side-effects:
 *   - `account.deleted` audit row written before the delete (actorId = null
 *     so it survives the cascade).
 *   - No email to the user; we already sent "scheduled" + the user had
 *     30 days. Sending "you're now deleted" is awkward UX and there's
 *     nobody to act on it.
 */

import { OrgRole } from '@prisma/client';

import { logger } from '@/lib/logger';
import { prisma } from '@/lib/db';
import { recordAudit } from '@/lib/audit';

async function main() {
  const now = new Date();
  const due = await prisma.user.findMany({
    where: {
      status: 'PENDING_DELETION',
      deletionScheduledAt: { lt: now },
    },
    select: {
      id: true,
      email: true,
      memberships: {
        select: {
          role: true,
          organization: { select: { id: true, slug: true } },
        },
      },
    },
    take: 200, // soft batch cap; cron runs daily so plenty of headroom.
  });

  if (due.length === 0) {
    logger.info('deletion-cron-no-due-rows');
    return;
  }
  logger.info({ count: due.length }, 'deletion-cron-batch');

  for (const user of due) {
    try {
      // Defensive: refuse to hard-delete if the user is the OWNER of any
      // *non-personal* multi-member org. The scheduler also blocks this,
      // but the 30-day window is long enough for state to drift.
      const blockingOrgIds = user.memberships
        .filter((m) => m.role === OrgRole.OWNER && !m.organization.slug.startsWith('personal-'))
        .map((m) => m.organization.id);
      if (blockingOrgIds.length > 0) {
        logger.error(
          { userId: user.id, orgIds: blockingOrgIds },
          'deletion-cron-skipped-owner-of-orgs',
        );
        continue;
      }

      // Record the audit before deletion so the row's references are
      // resolvable. AuditLog has no FK on actorId, so nulling out is fine.
      await recordAudit({
        actorId: null,
        action: 'account.deleted',
        target: user.id,
        metadata: { email: user.email ?? null, by: 'cron' },
      });

      // Delete the personal orgs the user owns. Cascade on Membership
      // would otherwise leave behind "personal-xxxx" orgs with zero
      // members.
      const personalOrgIds = user.memberships
        .filter((m) => m.organization.slug.startsWith('personal-'))
        .map((m) => m.organization.id);

      await prisma.$transaction([
        ...personalOrgIds.map((id) => prisma.organization.delete({ where: { id } })),
        prisma.user.delete({ where: { id: user.id } }),
      ]);

      logger.info(
        { userId: user.id, personalOrgIds, count: personalOrgIds.length },
        'deletion-cron-account-deleted',
      );
    } catch (err) {
      logger.error({ err, userId: user.id }, 'deletion-cron-row-failed');
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'run-deletion-cron-fatal');
    process.exit(1);
  });
