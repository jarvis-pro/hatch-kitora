-- RFC 0002 PR-2 — 2FA (TOTP + backup codes)
-- Adds TwoFactorSecret and the denormalized User.twoFactorEnabled flag.
-- The flag is the canonical "is 2FA on?" check used by the jwt callback and
-- the org enforcement wall — kept in sync with TwoFactorSecret.enabledAt
-- inside the enable / disable transactions.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "TwoFactorSecret" (
    "userId" TEXT NOT NULL,
    "encSecret" BYTEA NOT NULL,
    "enabledAt" TIMESTAMP(3),
    "backupHashes" TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwoFactorSecret_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "TwoFactorSecret" ADD CONSTRAINT "TwoFactorSecret_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
