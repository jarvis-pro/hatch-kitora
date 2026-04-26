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

## What's still left in code (RFC 0006 deliverables)

The provider factory in `src/lib/region/providers.ts` throws
`*-not-implemented in v0.6.0` for the CN branches today (see RFC 0005
§4.2 for the rationale). RFC 0006 wires:

- `aliyunDirectMailProvider` (replaces Resend in `getEmailProvider`);
- `aliyunOssProvider` (replaces S3 in `getStorageProvider`);
- finalising `WechatPayProvider` / `AlipayProvider` so
  `getBillingProvider` doesn't fall through to Stripe.

Same RFC also covers the rate-limit module rewrite (Upstash → Aliyun
Redis SDK).

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
