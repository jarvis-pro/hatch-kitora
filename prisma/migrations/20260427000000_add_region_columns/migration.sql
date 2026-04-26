-- RFC 0005 PR-1 — Multi-region (data residency).
--
-- Adds the `Region` enum and stamps every tenant-scoped row with a region.
-- Backfill is the trivially-safe `GLOBAL` for every legacy row: the only
-- stack that has ever run this migration *is* the GLOBAL stack (kitora.io).
-- The CN / EU stacks are spun up fresh in RFC 0006+, so no historical row
-- ever needs a non-GLOBAL backfill.
--
-- Order of operations:
--   1.  Create the enum.
--   2.  Add columns with GLOBAL default + NOT NULL right away (DEFAULT
--       handles backfill in a single statement).
--   3.  Drop the legacy `User.email` UNIQUE / `User.email` plain index and
--       rebuild as the `(email, region)` composite UNIQUE. Keeping the old
--       indexes around would just waste write-amp.
--   4.  Add the per-table `region` btree indexes used by the audit /
--       org-listing hot paths.

-- 1) Enum ---------------------------------------------------------------
CREATE TYPE "Region" AS ENUM ('GLOBAL', 'CN', 'EU');

-- 2) Region columns -----------------------------------------------------
-- Postgres applies the DEFAULT to existing rows in the same statement, so
-- there's no separate UPDATE / NOT NULL pass.
ALTER TABLE "User"
    ADD COLUMN "region" "Region" NOT NULL DEFAULT 'GLOBAL';

ALTER TABLE "Organization"
    ADD COLUMN "region" "Region" NOT NULL DEFAULT 'GLOBAL';

ALTER TABLE "AuditLog"
    ADD COLUMN "region" "Region" NOT NULL DEFAULT 'GLOBAL';

-- 3) Rebuild User.email uniqueness around (email, region) ---------------
-- The legacy index names match what `prisma migrate` emits at init time
-- (see 20260425131203_init/migration.sql). On a freshly-cloned dev DB they
-- exist; on any environment that introspected an older snapshot they'd
-- still exist under the same names, so DROP without IF EXISTS is fine.
DROP INDEX "User_email_key";
DROP INDEX "User_email_idx";

CREATE UNIQUE INDEX "User_email_region_key" ON "User"("email", "region");

-- 4) Region btree indexes ----------------------------------------------
CREATE INDEX "User_region_idx" ON "User"("region");
CREATE INDEX "Organization_region_idx" ON "Organization"("region");

-- AuditLog gets a (region, createdAt) composite. The compliance reporting
-- query is "give me the last N audit rows in this region" — region
-- leading the index keeps it sargable for that specific shape.
CREATE INDEX "AuditLog_region_createdAt_idx" ON "AuditLog"("region", "createdAt");
