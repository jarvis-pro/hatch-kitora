-- RFC 0008 PR-1 — Generic Background Jobs.
--
-- Adds:
--   * `BackgroundJobStatus` enum — 6-state machine for the unified
--     job lifecycle (PENDING / RUNNING / SUCCEEDED / FAILED /
--     DEAD_LETTER / CANCELED).
--   * `BackgroundJob` table — generic container for one-off async
--     work (email retry, token cleanup, scheduled sweep tick wrappers,
--     etc.). Domain-specific tables (`WebhookDelivery`, `DataExportJob`,
--     `User.deletionScheduledAt`) are deliberately untouched per
--     RFC 0008 §3.2 — those state machines are first-class business
--     facts, not infra leakage.
--
-- Pure additive migration. No backfill, no FK touch on existing tables.
-- Zero downtime: drop is `DROP TABLE "BackgroundJob"` + `DROP TYPE
-- "BackgroundJobStatus"` (no inbound dependencies).
--
-- Index design (RFC 0008 §3.1):
--
--   1. (type, runId) UNIQUE — idempotency hard guarantee. NULL runId
--      participates in NULLS DISTINCT (PG default), so callers passing
--      runId = NULL get no dedup, which is exactly what ad-hoc fire-and-
--      forget enqueues want.
--
--   2. (status, queue, priority, nextAttemptAt) — claim hot path.
--      Order matches the worker's
--          WHERE status = 'PENDING' AND queue = $1
--                AND nextAttemptAt <= now()
--          ORDER BY priority DESC, nextAttemptAt ASC
--          FOR UPDATE SKIP LOCKED
--      so the index drives both the WHERE and ORDER BY without a sort.
--
--   3. (deleteAt) — `job.prune` daily sweep, single-column b-tree range.
--
--   4. (type, status) — admin filter view
--      `/admin/jobs?type=email.send&status=FAILED`.

-- 1) Enum --------------------------------------------------------------
CREATE TYPE "BackgroundJobStatus" AS ENUM (
    'PENDING',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'DEAD_LETTER',
    'CANCELED'
);

-- 2) Table -------------------------------------------------------------
CREATE TABLE "BackgroundJob" (
    "id"            TEXT                  NOT NULL,
    "type"          TEXT                  NOT NULL,
    "payload"       JSONB                 NOT NULL,
    "runId"         TEXT,
    "status"        "BackgroundJobStatus" NOT NULL DEFAULT 'PENDING',
    "priority"      INTEGER               NOT NULL DEFAULT 0,
    "queue"         TEXT                  NOT NULL DEFAULT 'default',
    "attempt"       INTEGER               NOT NULL DEFAULT 0,
    "maxAttempts"   INTEGER               NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy"      TEXT,
    "lockedAt"      TIMESTAMP(3),
    "lastError"     TEXT,
    "result"        JSONB,
    "createdAt"     TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt"     TIMESTAMP(3),
    "completedAt"   TIMESTAMP(3),
    "deleteAt"      TIMESTAMP(3),
    CONSTRAINT "BackgroundJob_pkey" PRIMARY KEY ("id")
);

-- 3) Indexes -----------------------------------------------------------
CREATE UNIQUE INDEX "background_job_type_run_unique"
    ON "BackgroundJob"("type", "runId");

CREATE INDEX "background_job_claim_idx"
    ON "BackgroundJob"("status", "queue", "priority", "nextAttemptAt");

CREATE INDEX "background_job_prune_idx"
    ON "BackgroundJob"("deleteAt");

CREATE INDEX "BackgroundJob_type_status_idx"
    ON "BackgroundJob"("type", "status");
