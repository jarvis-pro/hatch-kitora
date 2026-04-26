-- RFC 0006 PR-3 — CN-billing subscription fields.
--
-- Adds three columns to Subscription so Alipay / WeChat rows can sit in
-- the same table as Stripe rows without synthesising fake Stripe IDs:
--   * `provider`              — discriminator, defaults 'stripe' so all
--                                pre-existing rows keep their semantics.
--   * `cnAgreementId`         — 支付宝免密协议号 / WeChat 周期扣款合同号.
--   * `stripeSubscriptionId`  — relaxed to nullable; CN rows leave it
--                                NULL.  The original UNIQUE constraint
--                                still holds because Postgres treats NULL
--                                as distinct under UNIQUE.
--
-- Order of operations:
--   1. Add `provider` with NOT NULL default 'stripe' — single statement
--      handles backfill.
--   2. Add `cnAgreementId` — nullable, no backfill needed (no historical
--      CN rows exist; `Region.CN` stack hasn't booted yet per RFC 0005).
--   3. Drop the NOT NULL on `stripeSubscriptionId` — keep the UNIQUE
--      index, just relax the not-null. Existing UNIQUE auto-survives.
--   4. New indexes: `(provider)` + `(cnAgreementId)` for the obvious hot
--      paths the CN webhook resolves on.

-- 1) provider column ---------------------------------------------------
ALTER TABLE "Subscription"
    ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'stripe';

-- 2) cnAgreementId column + unique --------------------------------------
ALTER TABLE "Subscription"
    ADD COLUMN "cnAgreementId" TEXT;

CREATE UNIQUE INDEX "Subscription_cnAgreementId_key"
    ON "Subscription"("cnAgreementId");

-- 3) Relax stripeSubscriptionId to nullable -----------------------------
ALTER TABLE "Subscription"
    ALTER COLUMN "stripeSubscriptionId" DROP NOT NULL;

-- 4) Helper indexes -----------------------------------------------------
-- `cnAgreementId` already has a btree from the unique index above.
CREATE INDEX "Subscription_provider_idx" ON "Subscription"("provider");
