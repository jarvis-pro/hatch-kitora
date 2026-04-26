# Deploy — CN region (kitora.cn)

> **Status**: stub. The work to actually ship a paying CN stack is RFC 0006. This file is the procurement + filing checklist that has to be
> ticked before that RFC can land. Estimate ≈ 30 working days, of which
> ICP filing alone is ~20.

The CN stack is a self-contained, share-nothing twin of the GLOBAL
stack (RFC 0005 §6). It serves users in mainland China and only those
users; cross-region data movement is forbidden by both regulation
(网络安全法 / 数据安全法 / PIPL) and our own application code (RFC
0005 §5).

## Topology (target)

```
                ┌────────────────────────────────────────────┐
                │      kitora.cn  (region: CN)               │
                │                                            │
   browsers ───▶│  Aliyun ACK Shanghai (Node 22)             │
                │   ▲                                        │
                │   │   ENV: KITORA_REGION=CN                │
                │   ├── Aliyun RDS PostgreSQL (cn-shanghai)  │
                │   ├── Aliyun Redis (cn-shanghai)           │
                │   ├── Aliyun OSS (cn-shanghai)             │
                │   ├── Aliyun DirectMail                    │
                │   ├── Alipay or WeChat Pay                 │
                │   └── Aliyun SLS (logs / audit)            │
                └────────────────────────────────────────────┘
```

## Filings + accounts (RFC 0006 §1)

- [ ] **ICP 备案** (网信办). Required to point a `kitora.cn` A record
      anywhere in mainland China. ~20 working days. Apply through
      Aliyun's filing portal once the domain is registered.
- [ ] **公安部备案** (网安备). Filed after ICP comes through. ~5
      working days. Filing number goes into `PUBLIC_SECURITY_NUMBER`
      and renders in the footer (`SiteFooter` already handles the
      conditional render via `isCnRegion()`).
- [ ] **Aliyun corporate account** in 实名认证 status. Personal
      accounts can't host SaaS in production.
- [ ] **Domain name `kitora.cn`** registered through a Chinese
      registrar (CNNIC-accredited). Aliyun bundles registration with
      filing.

## Resource procurement (RFC 0006 §2)

- [ ] **RDS for PostgreSQL** — minimum spec to be sized after a load
      profile from the GLOBAL stack. Set `DATABASE_URL` to the VPC
      endpoint; expose the public endpoint only for migrations.
- [ ] **Redis** — Aliyun's hosted Redis. Replace
      `UPSTASH_REDIS_REST_URL` with the corresponding Aliyun
      equivalent in the rate-limit module (RFC 0006 deliverable).
- [ ] **OSS bucket** — naming `kitora-cn-<env>-data-export`. Bucket
      policy mirrors the S3 setup; `aliyunOssProvider` slots into
      `getStorageProvider()` in `src/lib/region/providers.ts`.
- [ ] **DirectMail** — Aliyun's transactional email rail. Verified
      sender domain on `mail.kitora.cn`.
- [ ] **Alipay or WeChat Pay merchant account**. The provider
      factory's CN branch picks one (toggle via `WECHAT_PAY_MCH_ID`).
- [ ] **SLS log project** — every audit row written by `recordAudit()`
      already carries `region = CN`; SLS index lives in `cn-shanghai`
      so监管 sees logs only inside the border.

## Region wiring

```env
KITORA_REGION=CN
```

Set in:

- the Aliyun ACK deployment (image built with
  `--build-arg KITORA_REGION=CN`);
- Aliyun ACS env mapping for runtime;
- the CN CI/CD pipeline.

The boot-time guard (`assertRegionMatchesDatabase`) panics if the
configured DB carries any non-CN org row. This is the only thing
preventing a misconfigured CN cluster from polluting GLOBAL data.

## What's wired in code (RFC 0006)

PR-2 / PR-3 / PR-4 / PR-5 land in v0.7.0; the provider factory in
`src/lib/region/providers.ts` no longer throws on the CN branches:

- **`AliyunOssProvider`** (`src/lib/storage/aliyun-oss.ts`) implements
  `StorageProvider` against `ali-oss`@6+ with v4 signing. The storage
  facade in `src/lib/storage/index.ts` short-circuits to it whenever
  `isCnRegion()` is true, ignoring `DATA_EXPORT_STORAGE`.
- **`sendAliyunDirectMail()`** (`src/lib/email/aliyun-direct-mail.ts`)
  wraps `@alicloud/dm20151123` for transactional email. `sendEmail()` in
  `src/lib/email/send.ts` branches on `isCnRegion()`.
- **`AlipayProvider` / `WechatPayProvider`** (`src/lib/billing/provider/`)
  carry full hosted-checkout + async-notify + refund flows. Inbound
  webhooks land at `src/app/api/billing/{alipay,wechat}/notify/route.ts`,
  dedup'd via the `BillingEvent` table (RFC 0006 §6.2).
- **`buildAliyunRedisLimiter()`** (`src/lib/rate-limit.ts`) replaces the
  Upstash REST limiter with a hand-rolled ZSET sliding window over
  `ioredis` whenever `isCnRegion()` is true.
- **`/legal/data-rights`** route (CN-only, 404 elsewhere) surfaces the
  PIPL §44 four-rights menu (query / correct / delete / port) by
  routing to the existing settings flows.
- **`scripts/audit-egress.ts`** scans `src/` + `scripts/` for
  forbidden host references; CI runs it in strict mode for CN deploys.
- **`.github/workflows/deploy-cn.yml`** builds with `KITORA_REGION=CN`
  build-arg, pushes to ACR, rolls out on ACK, smoke-tests `/api/health`,
  rolls back on failure.

What requires real procurement (this RFC's scope ends at code):

- The 9 `ALIYUN_*` / `ALIPAY_*` / `WECHAT_PAY_*` env values must be
  filled with real merchant credentials before the stack accepts
  payments or sends email.
- ICP / 公安部 备案 must be completed before DNS resolves.

## Background jobs cron (RFC 0008)

The `BackgroundJob` table runs through a Kubernetes CronJob in ACK
(Aliyun managed K8s). Vercel Cron is **not** an option here — the stack
lives entirely in CN.

```yaml
# infra/aliyun/cronjob.yaml (apply with kubectl apply -f, namespace = kitora-cn)
apiVersion: batch/v1
kind: CronJob
metadata:
  name: jobs-tick
  namespace: kitora-cn
spec:
  schedule: '* * * * *' # every minute (UTC)
  concurrencyPolicy: Forbid # tick N+1 won't start if N is still running
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      backoffLimit: 0 # don't auto-retry; the lib owns retry logic
      template:
        spec:
          serviceAccountName: kitora-jobs
          restartPolicy: Never
          containers:
            - name: jobs
              image: <ACR_REGISTRY>/kitora:<VERSION>
              command: ['pnpm', 'tsx', 'scripts/run-jobs.ts']
              envFrom:
                - secretRef:
                    name: kitora-env-cn
              resources:
                requests: { cpu: '100m', memory: '256Mi' }
                limits: { cpu: '500m', memory: '512Mi' }
```

Notes:

- `concurrencyPolicy: Forbid` is the safe default. Even though
  `FOR UPDATE SKIP LOCKED` makes parallel ticks safe at the DB level,
  serialising at the K8s layer keeps observability cleaner (one
  `jobs-tick-complete` log line per minute, not five).
- `backoffLimit: 0`: the per-job retry / DLQ logic lives in
  `src/lib/jobs/runner.ts`. Letting K8s retry the whole CronJob pod would
  double-fire schedule投影 + 误增 attempt 计数。
- `CRON_SECRET` is **not needed** here — the CLI doesn't go through
  `/api/jobs/tick`. Leave it unset on the CN stack.
- Cron schedules in `defineSchedule(...)` are interpreted as **UTC**
  (RFC 0008 §4.3). The `'0 3 * * *'` deletion sweep fires at UTC 03:00
  = Beijing 11:00; if ops want it at Beijing 03:00, change the
  `defineSchedule` cron to `'0 19 * * *'` (UTC 19:00 = previous-day
  Beijing 03:00) and redeploy.
- Logs go to SLS (Aliyun Log Service) via the same pino → SLS bridge the
  rest of the app uses (RFC 0006 §4).

## Sanity checks (once stack is live)

- `https://kitora.cn/api/health` returns 200 from a Chinese ISP.
- Footer shows `<ICP_NUMBER>` + `<PUBLIC_SECURITY_NUMBER>` (already
  wired in `SiteFooter` via `isCnRegion()`).
- `select region, count(*) from "Organization" group by region;`
  returns exactly one row, `region = 'CN'`. Any other row means
  somebody pointed `KITORA_REGION` at the wrong DB.
- A signup from a kitora.cn-resident IP creates a `User` with
  `region = 'CN'`; the same email signing up on kitora.io creates a
  separate, independent `User` row with `region = 'GLOBAL'`.
