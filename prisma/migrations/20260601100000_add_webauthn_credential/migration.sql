-- RFC 0007 PR-1 — WebAuthn / Passkey credentials.
--
-- Adds:
--   * `WebAuthnCredential` table — one row per credential (passkey) the
--     user has registered. Multiple per user is the norm.
--   * `User.webauthnChallenge` + `webauthnChallengeAt` — short-lived
--     state for the current register / authenticate ceremony. Cleared
--     on verify (success or fail) or after 5 minutes (lazy: read-time
--     expiry check in src/lib/webauthn/challenge.ts).
--
-- Pure additive migration. Existing User rows get NULL for the new
-- columns; no backfill required.

-- 1) Add ephemeral challenge state to User -----------------------------
ALTER TABLE "User"
    ADD COLUMN "webauthnChallenge"   TEXT,
    ADD COLUMN "webauthnChallengeAt" TIMESTAMP(3);

-- 2) WebAuthnCredential --------------------------------------------------
CREATE TABLE "WebAuthnCredential" (
    "id"           TEXT         NOT NULL,
    "userId"       TEXT         NOT NULL,
    "credentialId" TEXT         NOT NULL,
    "publicKey"    BYTEA        NOT NULL,
    "counter"      INTEGER      NOT NULL DEFAULT 0,
    "transports"   TEXT[]       NOT NULL,
    "deviceType"   TEXT         NOT NULL,
    "backedUp"     BOOLEAN      NOT NULL,
    "name"         TEXT         NOT NULL,
    "lastUsedAt"   TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key"
    ON "WebAuthnCredential"("credentialId");

CREATE INDEX "WebAuthnCredential_userId_lastUsedAt_idx"
    ON "WebAuthnCredential"("userId", "lastUsedAt");

ALTER TABLE "WebAuthnCredential"
    ADD CONSTRAINT "WebAuthnCredential_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
