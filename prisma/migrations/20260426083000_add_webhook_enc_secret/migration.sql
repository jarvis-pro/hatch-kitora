-- RFC 0003 PR-2 — store encrypted plaintext webhook secret.
--
-- PR-1 stored only sha256(secret) for "secret-hash matches token" lookups,
-- but the cron worker needs the *plaintext* to sign outgoing payloads with
-- HMAC. We add a new `encSecret` column (HKDF-derived AES-256-GCM, same
-- pattern as TwoFactorSecret.encSecret) and keep the existing `secretHash`
-- for backwards-compat / UI fingerprint use. New endpoints fill both.

-- AlterTable
ALTER TABLE "WebhookEndpoint" ADD COLUMN "encSecret" BYTEA;
