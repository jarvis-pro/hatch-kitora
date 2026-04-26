// NOTE: deliberately *not* `'server-only'` here — Playwright e2e tests
// drive `runWebhookCronTick` in-process to assert end-to-end DELIVERED
// status writes. The transitive `@/lib/db` (prisma) + `@/env` deps still
// gate accidental client bundling.
//
// Library form of the cron worker. The CLI entry (`scripts/run-webhook-cron.ts`)
// is a thin wrapper that calls `runWebhookCronTick()` and translates errors
// into a non-zero exit code.

import { logger } from '@/lib/logger';
import { prisma } from '@/lib/db';

import { deliverWebhook } from './deliver';
import { sendWebhookAutoDisabledEmail } from './email-flows';
import { decryptSecret } from './secret';

const STUCK_MS = 5 * 60 * 1000;
const BATCH = 50;
// RFC 0003 PR-4 — auto-disable threshold. 8 consecutive failures × the
// retry curve (~44h) lands at ≈ 2 days of pain before we pause the
// endpoint. Tunable here without touching the state machine.
const AUTO_DISABLE_THRESHOLD = 8;
// Terminal-delivery retention. Past this we don't keep the row even if the
// user might want to "Resend" it — practical experience says nobody chases
// a webhook this old, and the table grows fast otherwise.
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * RFC 0003 PR-2 — outbound webhook cron tick.
 *
 * Three phases per invocation, mirroring `scripts/run-export-jobs.ts`:
 *
 *   1. Recover stuck — anything in PENDING with `nextAttemptAt` ages older
 *      than STUCK_MS (≈ 5 min) is most likely a previous worker that
 *      crashed mid-fetch; nudge it back so this tick can pick it up.
 *   2. Claim + deliver — pull up to BATCH rows whose `nextAttemptAt < now`
 *      and `status IN (PENDING, RETRYING)`, optimistic-claim each by
 *      flipping to a "claimed" sentinel (we re-use PENDING with a
 *      `nextAttemptAt = null` tombstone), then POST and write back.
 *   3. Sweep orphans — endpoints disabled / deleted may leave PENDING
 *      rows. Those get flipped to CANCELED so the queue stays bounded.
 *
 * The "claim" trick: there's no ON CONFLICT semantics in Prisma we can
 * lean on for batch claims, so the worker calls `updateMany` with the
 * row id list it just SELECTed. Whoever wins the second updateMany owns
 * the row — duplicates produce 0 row updates and are silently skipped.
 */
export async function runWebhookCronTick(): Promise<void> {
  await recoverStuck();
  await claimAndDeliver();
  await sweepOrphans();
  await sweepTerminalDeliveries();
}

async function recoverStuck() {
  // PENDING rows with `nextAttemptAt` more than STUCK_MS in the past
  // belong to a crashed worker. updateMany with a bumped `nextAttemptAt`
  // brings them forward; status doesn't change.
  const cutoff = new Date(Date.now() - STUCK_MS);
  const result = await prisma.webhookDelivery.updateMany({
    where: {
      status: 'PENDING',
      nextAttemptAt: { lt: cutoff },
      // Skip rows that were just enqueued — those are intentionally now-ish.
      // We only want to rescue *stale* PENDINGs.
    },
    data: { nextAttemptAt: new Date() },
  });
  if (result.count > 0) {
    logger.warn({ count: result.count }, 'webhook-cron-stuck-recovered');
  }
}

async function claimAndDeliver() {
  const now = new Date();
  // Phase 1: pick candidates.
  const candidates = await prisma.webhookDelivery.findMany({
    where: {
      status: { in: ['PENDING', 'RETRYING'] },
      nextAttemptAt: { lte: now },
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: BATCH,
    select: { id: true },
  });
  if (candidates.length === 0) return;

  for (const { id } of candidates) {
    // Phase 2: optimistic claim. Whichever worker wins flips the row to
    // a "claimed" state we represent as `status = PENDING, nextAttemptAt
    // = null`. Future cron ticks won't re-pick a null-nextAttemptAt row.
    const claim = await prisma.webhookDelivery.updateMany({
      where: { id, status: { in: ['PENDING', 'RETRYING'] }, nextAttemptAt: { lte: now } },
      data: { nextAttemptAt: null, status: 'PENDING' },
    });
    if (claim.count === 0) continue; // someone else got it

    const delivery = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        eventId: true,
        eventType: true,
        payload: true,
        attempt: true,
        endpoint: {
          select: {
            id: true,
            url: true,
            encSecret: true,
            disabledAt: true,
            consecutiveFailures: true,
          },
        },
      },
    });

    // Endpoint disabled mid-flight → CANCELED, no fetch.
    if (delivery.endpoint.disabledAt) {
      await prisma.webhookDelivery.update({
        where: { id },
        data: {
          status: 'CANCELED',
          errorMessage: 'endpoint-disabled',
          completedAt: new Date(),
        },
      });
      continue;
    }

    // Endpoint predates PR-2 (no encSecret). Mark DEAD_LETTER with a
    // clear error so the user knows to rotate-secret + retry. Should
    // never happen for endpoints created post-migration.
    if (!delivery.endpoint.encSecret) {
      await prisma.webhookDelivery.update({
        where: { id },
        data: {
          status: 'DEAD_LETTER',
          errorMessage: 'endpoint-missing-encrypted-secret-rotate-and-retry',
          completedAt: new Date(),
        },
      });
      continue;
    }

    let plainSecret: string;
    try {
      plainSecret = decryptSecret(delivery.endpoint.id, Buffer.from(delivery.endpoint.encSecret));
    } catch (err) {
      // Decryption failure means the AUTH_SECRET rotated without re-encrypt.
      // Same recovery path as missing encSecret above.
      logger.error({ err, endpointId: delivery.endpoint.id }, 'webhook-decrypt-failed');
      await prisma.webhookDelivery.update({
        where: { id },
        data: {
          status: 'DEAD_LETTER',
          errorMessage: 'secret-decrypt-failed',
          completedAt: new Date(),
        },
      });
      continue;
    }

    const result = await deliverWebhook({
      url: delivery.endpoint.url,
      secret: plainSecret,
      eventId: delivery.eventId,
      eventType: delivery.eventType,
      payload: delivery.payload as object,
      attempt: delivery.attempt + 1,
    });

    // Phase 3: write the outcome back.
    await applyOutcome(delivery.id, delivery.endpoint.id, delivery.attempt + 1, result);
  }
}

type ApplyResult = Awaited<ReturnType<typeof deliverWebhook>>;

async function applyOutcome(
  deliveryId: string,
  endpointId: string,
  newAttempt: number,
  result: ApplyResult,
) {
  if (result.kind === 'delivered') {
    await prisma.$transaction([
      prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'DELIVERED',
          attempt: newAttempt,
          responseStatus: result.responseStatus,
          responseBody: result.responseBody,
          completedAt: new Date(),
        },
      }),
      prisma.webhookEndpoint.update({
        where: { id: endpointId },
        data: { consecutiveFailures: 0 },
      }),
    ]);
    return;
  }
  if (result.kind === 'dead-letter') {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'DEAD_LETTER',
        attempt: newAttempt,
        responseStatus: result.responseStatus,
        responseBody: result.responseBody,
        errorMessage: result.errorMessage?.slice(0, 500) ?? null,
        completedAt: new Date(),
      },
    });
    await bumpFailuresAndMaybeDisable(endpointId);
    return;
  }
  // retry
  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: 'RETRYING',
      attempt: newAttempt,
      responseStatus: result.responseStatus,
      responseBody: result.responseBody,
      errorMessage: result.errorMessage?.slice(0, 500) ?? null,
      nextAttemptAt: new Date(Date.now() + result.delayMs),
    },
  });
  await bumpFailuresAndMaybeDisable(endpointId);
}

/**
 * Increment `consecutiveFailures` and — if we just crossed the auto-disable
 * threshold — flip `disabledAt`, write an actor=null audit row, and email
 * OWNER + ADMIN of the org. Idempotent: the disabledAt guard means a second
 * crossing for the same endpoint is a no-op.
 *
 * Split out of `applyOutcome` (and *not* in a $transaction) because we need
 * the post-update value of `consecutiveFailures` to decide whether to
 * disable. Prisma's interactive transactions could express this, but the
 * worst case here is double-emailing on a worker race — not corrupting state
 * — so we keep it simple.
 */
async function bumpFailuresAndMaybeDisable(endpointId: string): Promise<void> {
  const updated = await prisma.webhookEndpoint.update({
    where: { id: endpointId },
    data: { consecutiveFailures: { increment: 1 } },
    select: {
      id: true,
      orgId: true,
      url: true,
      consecutiveFailures: true,
      disabledAt: true,
    },
  });
  if (updated.disabledAt) return; // already paused — nothing to do
  if (updated.consecutiveFailures < AUTO_DISABLE_THRESHOLD) return;

  await autoDisableEndpoint(updated);
}

interface DisableTarget {
  id: string;
  orgId: string;
  url: string;
  consecutiveFailures: number;
}

async function autoDisableEndpoint(endpoint: DisableTarget): Promise<void> {
  const now = new Date();
  // The where-clause guards against a race with manual edits — we only flip
  // disabledAt if it's still null. updateMany returns count 0 if someone
  // else won (e.g., admin manually disabled or re-enabled in the same tick).
  const flip = await prisma.webhookEndpoint.updateMany({
    where: { id: endpoint.id, disabledAt: null },
    data: { disabledAt: now },
  });
  if (flip.count === 0) {
    return; // someone else already paused / re-enabled — they own the audit row
  }

  // Audit row. We deliberately do NOT call `recordAudit()` here because that
  // would round-trip through `bridgeAuditToWebhook` and try to enqueue a
  // delivery for `webhook.endpoint_auto_disabled` to the *very endpoint we
  // just disabled* — exactly the death loop §8 of the RFC calls out. Direct
  // insert sidesteps the bridge.
  await prisma.auditLog.create({
    data: {
      actorId: null, // system action
      orgId: endpoint.orgId,
      action: 'webhook.endpoint_auto_disabled',
      target: endpoint.id,
      metadata: {
        url: endpoint.url,
        consecutiveFailures: endpoint.consecutiveFailures,
      },
    },
  });

  // Notify OWNER + ADMIN. Per-recipient try/catch already lives in
  // `sendWebhookAutoDisabledEmail`, so a single broken inbox can't poison
  // the rest of the fan-out.
  const [org, recipients] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: endpoint.orgId },
      select: { slug: true },
    }),
    prisma.membership.findMany({
      where: { orgId: endpoint.orgId, role: { in: ['OWNER', 'ADMIN'] } },
      select: { user: { select: { email: true, name: true } } },
    }),
  ]);

  if (!org) return; // orphaned endpoint — nobody to notify

  await Promise.all(
    recipients
      .map((m) => m.user)
      .filter((u): u is { email: string; name: string | null } => !!u?.email)
      .map((u) =>
        sendWebhookAutoDisabledEmail({
          to: u.email,
          name: u.name,
          endpointUrl: endpoint.url,
          endpointId: endpoint.id,
          orgSlug: org.slug,
          consecutiveFailures: endpoint.consecutiveFailures,
        }),
      ),
  );

  logger.warn(
    {
      endpointId: endpoint.id,
      orgId: endpoint.orgId,
      consecutiveFailures: endpoint.consecutiveFailures,
    },
    'webhook-endpoint-auto-disabled',
  );
}

async function sweepOrphans() {
  // Endpoints flipped to disabled mid-queue: their PENDING/RETRYING
  // rows still float around. Mass-CANCEL them so the queue doesn't
  // grow forever.
  const result = await prisma.webhookDelivery.updateMany({
    where: {
      status: { in: ['PENDING', 'RETRYING'] },
      endpoint: { disabledAt: { not: null } },
    },
    data: { status: 'CANCELED', completedAt: new Date(), errorMessage: 'endpoint-disabled' },
  });
  if (result.count > 0) {
    logger.info({ count: result.count }, 'webhook-cron-orphans-canceled');
  }
}

/**
 * RFC 0003 PR-4 — terminal-state retention sweep.
 *
 * DELIVERED / DEAD_LETTER / CANCELED rows older than TERMINAL_RETENTION_MS
 * are deleted. We don't soft-delete because nothing in the product reads
 * cancelled rows historically — the dashboard top-50 view shows recent
 * deliveries only.
 *
 * Runs on every cron tick rather than as a separate job because the
 * bookkeeping is cheap (single indexed deleteMany) and bundling it here
 * keeps the operational footprint to a single cron entry.
 */
async function sweepTerminalDeliveries() {
  const cutoff = new Date(Date.now() - TERMINAL_RETENTION_MS);
  const result = await prisma.webhookDelivery.deleteMany({
    where: {
      status: { in: ['DELIVERED', 'DEAD_LETTER', 'CANCELED'] },
      // `completedAt` is set when a row reaches terminal state; in the rare
      // case it isn't (legacy data), fall back to createdAt via OR.
      OR: [{ completedAt: { lt: cutoff } }, { completedAt: null, createdAt: { lt: cutoff } }],
    },
  });
  if (result.count > 0) {
    logger.info({ count: result.count }, 'webhook-cron-terminal-swept');
  }
}
