-- RFC 0006 PR-3 — CN billing webhook idempotency table.
--
-- Decision (deviation from RFC 0006 §6.2 first draft): we do NOT rename
-- StripeEvent → BillingEvent. The /admin/stripe-events admin UI and the
-- existing webhook idempotency logic depend on the StripeEvent shape;
-- renaming has zero functional payoff and a non-trivial blast radius.
--
-- Instead this migration creates a fresh `BillingEvent` table that only
-- stores Alipay + WeChat Pay events. Same idea (one row per
-- successfully-verified inbound notification, dedup on a composite of
-- `provider` and the SDK-provided event id). Stripe events keep their
-- own table.

CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,
    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingEvent_provider_providerEventId_key"
    ON "BillingEvent"("provider", "providerEventId");

CREATE INDEX "BillingEvent_provider_processedAt_idx"
    ON "BillingEvent"("provider", "processedAt");

CREATE INDEX "BillingEvent_type_idx" ON "BillingEvent"("type");
