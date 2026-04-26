# Deploy — GLOBAL region (kitora.io)

> **Status**: production runbook — this is what currently powers
> kitora.io. Mirror this page exactly when standing up a fresh GLOBAL
> environment (staging, on-prem demo, or a green-field replacement).

The GLOBAL stack is the catch-all for any customer outside mainland
China and the EU residency cohort. It's the only region that ships in
v0.6 — the CN stack waits on RFC 0006 (and ICP filings); EU is a
placeholder until a paying customer asks for it.

## Topology

```
                ┌───────────────────────────────────────┐
                │       kitora.io  (region: GLOBAL)     │
                │                                       │
   browsers ───▶│  Vercel / Cloud Run (Node 22)         │
                │   ▲                                   │
                │   │   ENV: KITORA_REGION=GLOBAL       │
                │   ├── Postgres (Neon / Supabase, us-east) │
                │   ├── Redis (Upstash, us-east)        │
                │   ├── Object storage (S3 us-east-1)   │
                │   ├── Email (Resend)                  │
                │   ├── Billing (Stripe)                │
                │   └── Logs/Errors (Sentry)            │
                └───────────────────────────────────────┘
```

Every backing service is GLOBAL-scoped. The CN stack runs the same
Docker image with `KITORA_REGION=CN` and a wholly separate set of
backing services (Aliyun-side; see `docs/deploy/cn.md`). Nothing
crosses between the two — the codebase is share-nothing by design (RFC
0005 §2).

## Prerequisites

- Postgres 15+ database, ideally with a connection pooler. Set
  `DATABASE_URL` to the pooled URL and `DIRECT_URL` to the direct one
  (Prisma uses it for migrations).
- Redis (Upstash REST or self-hosted). Set
  `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.
- S3 bucket, region `us-east-1` recommended. Set
  `DATA_EXPORT_S3_BUCKET`, `DATA_EXPORT_S3_REGION`,
  `DATA_EXPORT_S3_ACCESS_KEY_ID`, `DATA_EXPORT_S3_SECRET_ACCESS_KEY`.
  Set `DATA_EXPORT_STORAGE=s3` to flip the storage facade off
  local-FS.
- Stripe account in live mode. Set `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`,
  `STRIPE_TEAM_PRICE_ID`.
- Resend account + verified sender domain. Set `RESEND_API_KEY` and
  `EMAIL_FROM`.
- `AUTH_SECRET` — `openssl rand -base64 32`. Rotate by bumping
  `User.sessionVersion` (RFC 0002 PR-1) in lockstep so existing JWTs
  invalidate.
- Sentry project (optional). Set `NEXT_PUBLIC_SENTRY_DSN` +
  `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT` to upload
  source maps from CI.

## Region wiring

The single most important variable for this RFC:

```env
KITORA_REGION=GLOBAL
```

Set it in:

- the Docker image build (`--build-arg KITORA_REGION=GLOBAL`, baked
  into the image at build time so the runtime can't drift);
- the runtime environment (Vercel project env, Fly secret, k8s
  configmap — pick your platform);
- CI deploy pipelines (so staging + production agree).

Anything reads region through `currentRegion()` in `src/lib/region.ts`
— never `process.env.KITORA_REGION` directly. The middleware shim in
`src/middleware.ts` is the only exception (edge runtime can't import
the Node-only helper).

The startup hook in `src/instrumentation.ts` calls
`assertRegionMatchesDatabase()` — if the DB has any `Organization` rows
whose region doesn't match the env var, the process exits 1 instead of
silently writing rows into the wrong residency. Watch for the log line
`region-startup-mismatch` if a deploy refuses to come up.

## First-time rollout

1. Apply Prisma migrations against the production DB:
   ```sh
   pnpm prisma migrate deploy
   ```
   The `20260427000000_add_region_columns` migration backfills every
   pre-RFC-0005 row to `region = GLOBAL`. This is correct for the
   existing kitora.io data — there's no historical CN/EU data to
   stamp differently.
2. Build + push the image with `KITORA_REGION=GLOBAL` baked in:
   ```sh
   docker build --build-arg KITORA_REGION=GLOBAL -t kitora:global .
   ```
3. Roll out. The app comes up, hits the startup region check, logs
   `region-startup-check-ok`, and starts serving.

## Post-deploy sanity checks

- `curl https://kitora.io/api/health` returns 200.
- Pick any `Organization` row and confirm `region = 'GLOBAL'` in the
  DB.
- Sign up a brand-new test account; the `User.region` and the new
  `Organization.region` both come out `GLOBAL` (and the `(email,
region)` composite unique fires when retrying the same email).
- `audit_log` writes from that signup carry `region = 'GLOBAL'` —
  query `select region, count(*) from "AuditLog" group by region;`.
- Outgoing emails / Stripe checkouts work end-to-end (provider
  factory in `src/lib/region/providers.ts` resolves to Resend / S3 /
  Stripe).

## Rollback

The RFC 0005 schema migration is additive. To roll back:

```sh
pnpm prisma migrate resolve --rolled-back 20260427000000_add_region_columns
```

Then drop the columns + indexes added in the migration manually (see
the migration SQL for the exact list). Application code referencing
`region` will fall back to the column's default (`GLOBAL`) under the
old binary, so a forward + back rollout doesn't lose data.
