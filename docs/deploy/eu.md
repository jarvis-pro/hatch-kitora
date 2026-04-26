# Deploy — EU region (kitora.eu)

> **Status**: placeholder. EU residency is on the "nice to have" track
> (RFC 0005 §1) — promote out of placeholder once a paying enterprise
> customer asks for it. Until then this file's main job is to make sure
> the codebase doesn't drift away from being EU-launchable.

The EU stack would be share-nothing with both GLOBAL and CN: a separate
DB, separate object storage, separate auth domain. Region semantics
match GLOBAL: same Stripe / Resend / S3 providers (EU-region
endpoints), same code paths.

## What lives here today

- `Region.EU` is a valid Prisma enum value (`prisma/schema.prisma`)
  and a valid `KITORA_REGION` value (`src/env.ts`).
- The provider factory (`src/lib/region/providers.ts`) treats EU as a
  GLOBAL alias today (Stripe / Resend / default storage). When EU
  goes live we'll either keep this (cheaper, less ops surface) or
  swap in EU-region-specific endpoints/keys.
- `docker-compose.eu.yml` boots a vanilla Postgres + Redis pair under
  independent volumes for local development.

## Background jobs cron (RFC 0008)

When EU goes live, copy the `## Background jobs cron` recipe from
`docs/deploy/global.md` (Vercel + `CRON_SECRET` + `/api/jobs/tick`) — the
EU stack uses the same Vercel + Resend topology as GLOBAL, so Vercel Cron
is the right entry. No EU-specific cron infrastructure is anticipated.

## When this becomes real

- Register `kitora.eu` (any ICANN registrar; no special filing
  required, unlike CN).
- Pick an EU region for backing services: `eu-west-1` (Ireland) is
  the conventional pick; `eu-central-1` (Frankfurt) if a customer's
  GDPR posture requires Germany-specific residency.
- Build the image with `--build-arg KITORA_REGION=EU` and stand it
  up next to GLOBAL.
- Update this file and `docs/deploy/global.md` with the actual
  topology.
