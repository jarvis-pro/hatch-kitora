// RFC 0005 — Region drift safety check.
//
// Runs once at server boot via `instrumentation.ts`. The contract:
//
//   * If the database has at least one Organization row, every row's
//     region must equal `currentRegion()`. A single mismatch means
//     somebody flipped `KITORA_REGION` on a stack that was already
//     serving another region — refuse to start so we can't write rows
//     into the wrong residency.
//   * If the database is empty (fresh deploy, never seeded), pass. The
//     first signup will stamp the canonical region for everything.
//
// We deliberately don't fail on the `User` or `AuditLog` tables — those
// can carry historical rows from before the migration backfill (every
// such row is GLOBAL by construction) and we'd rather not block a CN
// stack that just hasn't seen any signups yet from booting.

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { currentRegion } from '@/lib/region';

let alreadyChecked = false;

export async function assertRegionMatchesDatabase(): Promise<void> {
  if (alreadyChecked) return;
  alreadyChecked = true;

  const expected = currentRegion();

  let conflict: { region: string; count: number } | null = null;
  try {
    // Group-by gives us "every region present + how many" in one query —
    // cheaper than a wide select even on large orgs tables.
    const rows = await prisma.organization.groupBy({
      by: ['region'],
      _count: { _all: true },
    });

    for (const row of rows) {
      if (row.region !== expected) {
        conflict = { region: row.region, count: row._count._all };
        break;
      }
    }
  } catch (err) {
    // If the query itself fails (DB unreachable, migration not run yet,
    // ...) log loudly but don't kill the process — we don't want a flaky
    // pre-flight to take down a healthy app. The next request will retry
    // implicit DB connection, and ops alerting will catch a real outage.
    logger.warn({ err }, 'region-startup-check-skipped');
    return;
  }

  if (conflict) {
    logger.fatal(
      { expected, found: conflict.region, foundCount: conflict.count },
      'region-startup-mismatch',
    );
    // `process.exit` rather than `throw` because Next.js swallows
    // instrumentation throws and merely warns. We want the container to
    // crash so the orchestrator surfaces the failure.
    process.exit(1);
  }

  logger.info({ region: expected }, 'region-startup-check-ok');
}
