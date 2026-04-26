-- RFC 0002 PR-4 — Account deletion grace period + Org-level 2FA enforcement
-- Two independent concerns landing together because both touch core lifecycle
-- tables (User, Organization). Migration is non-destructive: every new column
-- has a default, so existing rows pick up sensible values.

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'PENDING_DELETION');

-- AlterTable: User
ALTER TABLE "User" ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "User" ADD COLUMN "deletionScheduledAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "deletionRequestedFromIp" TEXT;

-- CreateIndex — daily cron query: pending users past their scheduled time.
CREATE INDEX "User_status_deletionScheduledAt_idx" ON "User"("status", "deletionScheduledAt");

-- AlterTable: Organization
ALTER TABLE "Organization" ADD COLUMN "require2fa" BOOLEAN NOT NULL DEFAULT false;
