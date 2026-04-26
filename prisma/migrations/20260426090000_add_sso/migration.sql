-- RFC 0004 PR-1 — SSO (SAML + OIDC + SCIM) base schema.
--
-- This migration is purely additive — no existing row is rewritten. The
-- Membership.providerId / providerSubject / deletedAt columns are nullable
-- so legacy rows (password / OAuth memberships) continue to validate
-- without backfill.
--
-- The IdentityProvider table holds at most 2 rows per org (1 SAML + 1 OIDC,
-- enforced via the unique below). secret material follows the same envelope
-- pattern as RFC 0002 / 0003: oidcClientSecret is AES-256-GCM ciphertext
-- with HKDF-derived key; scimTokenHash is sha256 of the plaintext token,
-- which is shown exactly once at create / rotate.

-- CreateEnum
CREATE TYPE "SsoProtocol" AS ENUM ('SAML', 'OIDC');

-- CreateTable
CREATE TABLE "IdentityProvider" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" "SsoProtocol" NOT NULL,
    "samlMetadata" TEXT,
    "oidcIssuer" TEXT,
    "oidcClientId" TEXT,
    "oidcClientSecret" BYTEA,
    "emailDomains" TEXT[],
    "defaultRole" "OrgRole" NOT NULL DEFAULT 'MEMBER',
    "enforceForLogin" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3),
    "scimTokenHash" TEXT,
    "scimTokenPrefix" TEXT,
    "scimEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdentityProvider_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IdentityProvider_scimTokenHash_key" ON "IdentityProvider"("scimTokenHash");

-- CreateIndex
CREATE INDEX "IdentityProvider_orgId_idx" ON "IdentityProvider"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityProvider_orgId_protocol_key" ON "IdentityProvider"("orgId", "protocol");

-- AddForeignKey
ALTER TABLE "IdentityProvider"
    ADD CONSTRAINT "IdentityProvider_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable — Membership SSO bookkeeping columns
ALTER TABLE "Membership" ADD COLUMN "providerId" TEXT;
ALTER TABLE "Membership" ADD COLUMN "providerSubject" TEXT;
ALTER TABLE "Membership" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateIndex — supports SSO callback's (providerId, providerSubject) lookup
CREATE INDEX "Membership_providerId_providerSubject_idx"
    ON "Membership"("providerId", "providerSubject");

-- AddForeignKey — Membership.providerId points back to the IdP it came from.
-- ON DELETE SET NULL: deleting an IdP shouldn't cascade-cull the memberships
-- (those users still belong to the org, just no longer via SSO).
ALTER TABLE "Membership"
    ADD CONSTRAINT "Membership_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "IdentityProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
