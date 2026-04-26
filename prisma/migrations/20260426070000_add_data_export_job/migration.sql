-- RFC 0002 PR-3 — GDPR data export jobs
-- Adds DataExportJob + the two enums it depends on. Cron worker
-- (scripts/run-export-jobs.ts) claims a PENDING row, builds the zip, and
-- writes back the completion fields. No FK on userId/orgId so deleting an
-- account / org doesn't cascade-delete the user's own export history (the
-- file gets purged separately on EXPIRED transition).

-- CreateEnum
CREATE TYPE "DataExportScope" AS ENUM ('USER', 'ORG');

-- CreateEnum
CREATE TYPE "DataExportStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "DataExportJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT,
    "scope" "DataExportScope" NOT NULL,
    "status" "DataExportStatus" NOT NULL DEFAULT 'PENDING',
    "storagePath" TEXT,
    "sizeBytes" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DataExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — list "my exports" / "this org's exports" hot path.
CREATE INDEX "DataExportJob_userId_idx" ON "DataExportJob"("userId");

-- CreateIndex
CREATE INDEX "DataExportJob_orgId_idx" ON "DataExportJob"("orgId");

-- CreateIndex — cron picks up `WHERE status = 'PENDING'` rows.
CREATE INDEX "DataExportJob_status_idx" ON "DataExportJob"("status");

-- CreateIndex — periodic sweep flips `expiresAt < now()` rows to EXPIRED.
CREATE INDEX "DataExportJob_expiresAt_idx" ON "DataExportJob"("expiresAt");
