import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // Database
    DATABASE_URL: z.string().url(),
    DIRECT_URL: z.string().url().optional(),

    // Auth.js
    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
    AUTH_URL: z.string().url().optional(),

    // OAuth providers (optional during initial dev)
    AUTH_GITHUB_ID: z.string().optional(),
    AUTH_GITHUB_SECRET: z.string().optional(),
    AUTH_GOOGLE_ID: z.string().optional(),
    AUTH_GOOGLE_SECRET: z.string().optional(),

    // Stripe
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_PRO_PRICE_ID: z.string().optional(),
    STRIPE_TEAM_PRICE_ID: z.string().optional(),

    // Email — accepts either a plain address (`a@b.com`) or the RFC 5322
    // "Name <a@b.com>" sender format used by Resend / SendGrid / SMTP.
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z
      .string()
      .refine(
        (v) =>
          /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(v) ||
          /^"?[^<>"]+?"?\s*<\s*[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+\s*>$/.test(v),
        { message: 'Must be a plain email or "Name <email@domain>" format' },
      )
      .default('Kitora <onboarding@example.com>'),

    // Upstash Redis (rate limiting)
    UPSTASH_REDIS_REST_URL: z.string().url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

    // RFC 0005 — Multi-region. `KITORA_REGION` is the canonical name and
    // its values are uppercase to align with the Prisma `Region` enum
    // (GLOBAL / CN / EU). It is a process-wide constant: read it through
    // `currentRegion()` in `src/lib/region.ts`, never via `process.env`
    // directly.
    //
    // The lower-case `REGION` is honoured for one deprecation window
    // (v0.6 + v0.7 accept it as an alias; v0.8 removes the read). When
    // both are set, `KITORA_REGION` wins. A `logger.warn` fires the first
    // time `currentRegion()` falls back to the legacy variable so
    // operators see the prompt to migrate.
    KITORA_REGION: z.enum(['GLOBAL', 'CN', 'EU']).optional(),
    REGION: z.enum(['global', 'cn']).optional(),

    // Mainland-China only: shown in the footer to satisfy ICP / 公安部备案
    // requirements. Both leave empty in 'global' mode.
    ICP_NUMBER: z.string().optional(),
    PUBLIC_SECURITY_NUMBER: z.string().optional(),

    // CN infrastructure credentials (RFC 0006 PR-2). All optional at the
    // env layer so dev / GLOBAL stacks boot fine without setting them;
    // the providers themselves throw a configuration error if a CN-region
    // request lands and the matching credential block is missing.
    //
    // RAM AccessKey is shared by Aliyun OSS (object storage) and DirectMail
    // (transactional email). Production uses a STS-backed RAM Role bound to
    // the ACK Service Account so these env vars only need filling for local
    // dev against a sandbox account.
    ALIYUN_ACCESS_KEY_ID: z.string().optional(),
    ALIYUN_ACCESS_KEY_SECRET: z.string().optional(),

    // OSS — bucket + region (e.g. cn-shanghai). Endpoint is optional and
    // only set when using a non-default endpoint (e.g. the VPC-internal
    // `oss-cn-shanghai-internal.aliyuncs.com` for ACK→OSS traffic).
    ALIYUN_OSS_BUCKET: z.string().optional(),
    ALIYUN_OSS_REGION: z.string().optional(),
    ALIYUN_OSS_ENDPOINT: z.string().url().optional(),

    // DirectMail — verified sender address (`AccountName` in DirectMail
    // parlance) and the regional endpoint (e.g.
    // `dm.cn-hangzhou.aliyuncs.com`). DirectMail's region can differ from
    // OSS / RDS region; cn-hangzhou is the canonical mainland endpoint.
    ALIYUN_DM_ACCOUNT_NAME: z.string().optional(),
    ALIYUN_DM_ENDPOINT: z.string().optional(),

    // Aliyun Redis — TCP-protocol Redis URL used by `src/lib/rate-limit.ts`
    // when `currentRegion()` is CN. Replaces Upstash REST in CN region
    // (Upstash sits outside the GFW, RTT >200ms is unacceptable on hot
    // paths). Format: `redis://:{password}@{host}:6379` or `rediss://...`
    // for the TLS port (6380). Should resolve over the VPC, not public.
    ALIYUN_REDIS_URL: z.string().optional(),

    // CN-payment credentials (RFC 0006 PR-3). All optional at the env layer
    // so dev / GLOBAL stacks boot fine without setting them; the providers
    // themselves throw a configuration error if a CN-region request lands
    // and the matching credential block is missing.
    //
    // Alipay — 「电脑网站支付 + 周期扣款」 needs four pieces:
    //   * APP_ID                — 应用 ID（开放平台拿到）
    //   * APP_PRIVATE_KEY       — 应用私钥（PKCS8, PEM 一行去掉 BEGIN/END）
    //   * ALIPAY_PUBLIC_KEY     — 支付宝公钥，用于回调验签
    //   * GATEWAY               — 默认正式网关；sandbox 时换成 openapi-sandbox
    ALIPAY_APP_ID: z.string().optional(),
    ALIPAY_PRIVATE_KEY: z.string().optional(),
    ALIPAY_PUBLIC_KEY: z.string().optional(),
    ALIPAY_GATEWAY: z.string().url().default('https://openapi.alipay.com/gateway.do'),
    // Webhook handlers want a stable hostname for `notify_url`; in CN region
    // this is `https://api.kitora.cn` (RFC 0006 §3.5). Fallback uses
    // NEXT_PUBLIC_APP_URL for dev / staging.
    CN_PUBLIC_API_URL: z.string().url().optional(),

    // WeChat Pay APIv3 — Native pay 二维码模式 + 周期扣款 (papay).
    //   * MCH_ID                — 商户号
    //   * APIV3_KEY             — APIv3 secret，用于回调 AES-GCM 解密
    //   * MERCHANT_PRIVATE_KEY  — 商户证书私钥 (PEM)
    //   * MERCHANT_SERIAL_NO    — 商户证书序列号
    //   * APP_ID                — 公众号 / 服务号 ID（Native 支付仍需）
    WECHAT_PAY_MCH_ID: z.string().optional(),
    WECHAT_PAY_APIV3_KEY: z.string().optional(),
    WECHAT_PAY_MERCHANT_PRIVATE_KEY: z.string().optional(),
    WECHAT_PAY_MERCHANT_SERIAL_NO: z.string().optional(),
    WECHAT_PAY_APP_ID: z.string().optional(),
    // Backwards compat — the old name `WECHAT_PAY_API_KEY` is the v2
    // signing key.  v3 callers must migrate to `WECHAT_PAY_APIV3_KEY`.
    // Keep accepting the legacy name for one deprecation window so existing
    // .env files don't fail validation on upgrade.
    WECHAT_PAY_API_KEY: z.string().optional(),

    // Logging
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // Data export (RFC 0002 PR-3) — where the cron worker drops finished
    // zip artefacts. `local` writes under DATA_EXPORT_LOCAL_DIR (defaults
    // to ./tmp/exports — git-ignored). `s3` requires the bucket + region
    // vars; signed URLs are minted at download time.
    DATA_EXPORT_STORAGE: z.enum(['local', 's3']).default('local'),
    DATA_EXPORT_LOCAL_DIR: z.string().default('./tmp/exports'),
    DATA_EXPORT_S3_BUCKET: z.string().optional(),
    DATA_EXPORT_S3_REGION: z.string().optional(),
    DATA_EXPORT_S3_ACCESS_KEY_ID: z.string().optional(),
    DATA_EXPORT_S3_SECRET_ACCESS_KEY: z.string().optional(),

    // RFC 0007 — WebAuthn / Passkey config. All optional; the lib auto-
    // derives sensible defaults from `NEXT_PUBLIC_APP_URL`. Override
    // explicitly when running behind a reverse proxy where the public
    // hostname differs from `NEXT_PUBLIC_APP_URL`.
    //
    //   * RP_ID    — eTLD+1 the credential binds to. Must match the
    //                document hostname browser-side. Production usually
    //                sets this to `kitora.io` / `kitora.cn` / `kitora.eu`.
    //                Dev / e2e can leave unset → falls back to URL host.
    //   * RP_NAME  — Human label in the consent prompt. Defaults `Kitora`.
    //   * ORIGIN   — Full origin (scheme + host + port). Defaults to
    //                `NEXT_PUBLIC_APP_URL`.
    WEBAUTHN_RP_ID: z.string().optional(),
    WEBAUTHN_RP_NAME: z.string().optional(),
    WEBAUTHN_ORIGIN: z.string().url().optional(),

    // Sentry — server-side build-time vars for source-map upload. Runtime DSN
    // is on the client side (NEXT_PUBLIC_SENTRY_DSN). All optional: missing
    // values just disable the relevant integration.
    SENTRY_AUTH_TOKEN: z.string().optional(),
    SENTRY_ORG: z.string().optional(),
    SENTRY_PROJECT: z.string().optional(),
    SENTRY_ENVIRONMENT: z.string().optional(),

    // RFC 0008 PR-4 — Background jobs Vercel Cron 鉴权密钥。
    //
    // `/api/jobs/tick` 路由比较 `Authorization: Bearer ${CRON_SECRET}`，
    // Vercel Cron 自动注入此 header；外部直访问统一返回 401（不泄露路径存在性，
    // 沿用 RFC 0003 webhook 同款模式）。
    //
    // 生产环境必须配 ≥ 32 字符强随机串：
    //
    //   openssl rand -base64 32
    //
    // dev / e2e 不强制（route 自身 503 「cron-not-configured」短路兜底，
    // CLI 入口 `pnpm tsx scripts/run-jobs.ts` 不走 HTTP 完全无影响）。
    CRON_SECRET: z.string().min(32).optional(),
  },
  client: {
    NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
    NEXT_PUBLIC_APP_NAME: z.string().default('Kitora'),
    NEXT_PUBLIC_ANALYTICS_ID: z.string().optional(),
    /** Public DSN — exposed to the browser. Empty string disables Sentry. */
    NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  },
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,

    DATABASE_URL: process.env.DATABASE_URL,
    DIRECT_URL: process.env.DIRECT_URL,

    AUTH_SECRET: process.env.AUTH_SECRET,
    AUTH_URL: process.env.AUTH_URL,
    AUTH_GITHUB_ID: process.env.AUTH_GITHUB_ID,
    AUTH_GITHUB_SECRET: process.env.AUTH_GITHUB_SECRET,
    AUTH_GOOGLE_ID: process.env.AUTH_GOOGLE_ID,
    AUTH_GOOGLE_SECRET: process.env.AUTH_GOOGLE_SECRET,

    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_PRO_PRICE_ID: process.env.STRIPE_PRO_PRICE_ID,
    STRIPE_TEAM_PRICE_ID: process.env.STRIPE_TEAM_PRICE_ID,

    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,

    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,

    KITORA_REGION: process.env.KITORA_REGION,
    REGION: process.env.REGION,
    ICP_NUMBER: process.env.ICP_NUMBER,
    PUBLIC_SECURITY_NUMBER: process.env.PUBLIC_SECURITY_NUMBER,
    ALIYUN_ACCESS_KEY_ID: process.env.ALIYUN_ACCESS_KEY_ID,
    ALIYUN_ACCESS_KEY_SECRET: process.env.ALIYUN_ACCESS_KEY_SECRET,
    ALIYUN_OSS_BUCKET: process.env.ALIYUN_OSS_BUCKET,
    ALIYUN_OSS_REGION: process.env.ALIYUN_OSS_REGION,
    ALIYUN_OSS_ENDPOINT: process.env.ALIYUN_OSS_ENDPOINT,
    ALIYUN_DM_ACCOUNT_NAME: process.env.ALIYUN_DM_ACCOUNT_NAME,
    ALIYUN_DM_ENDPOINT: process.env.ALIYUN_DM_ENDPOINT,
    ALIYUN_REDIS_URL: process.env.ALIYUN_REDIS_URL,
    ALIPAY_APP_ID: process.env.ALIPAY_APP_ID,
    ALIPAY_PRIVATE_KEY: process.env.ALIPAY_PRIVATE_KEY,
    ALIPAY_PUBLIC_KEY: process.env.ALIPAY_PUBLIC_KEY,
    ALIPAY_GATEWAY: process.env.ALIPAY_GATEWAY,
    CN_PUBLIC_API_URL: process.env.CN_PUBLIC_API_URL,
    WECHAT_PAY_MCH_ID: process.env.WECHAT_PAY_MCH_ID,
    WECHAT_PAY_APIV3_KEY: process.env.WECHAT_PAY_APIV3_KEY,
    WECHAT_PAY_MERCHANT_PRIVATE_KEY: process.env.WECHAT_PAY_MERCHANT_PRIVATE_KEY,
    WECHAT_PAY_MERCHANT_SERIAL_NO: process.env.WECHAT_PAY_MERCHANT_SERIAL_NO,
    WECHAT_PAY_APP_ID: process.env.WECHAT_PAY_APP_ID,
    WECHAT_PAY_API_KEY: process.env.WECHAT_PAY_API_KEY,

    LOG_LEVEL: process.env.LOG_LEVEL,

    DATA_EXPORT_STORAGE: process.env.DATA_EXPORT_STORAGE,
    DATA_EXPORT_LOCAL_DIR: process.env.DATA_EXPORT_LOCAL_DIR,
    DATA_EXPORT_S3_BUCKET: process.env.DATA_EXPORT_S3_BUCKET,
    DATA_EXPORT_S3_REGION: process.env.DATA_EXPORT_S3_REGION,
    DATA_EXPORT_S3_ACCESS_KEY_ID: process.env.DATA_EXPORT_S3_ACCESS_KEY_ID,
    DATA_EXPORT_S3_SECRET_ACCESS_KEY: process.env.DATA_EXPORT_S3_SECRET_ACCESS_KEY,

    WEBAUTHN_RP_ID: process.env.WEBAUTHN_RP_ID,
    WEBAUTHN_RP_NAME: process.env.WEBAUTHN_RP_NAME,
    WEBAUTHN_ORIGIN: process.env.WEBAUTHN_ORIGIN,

    SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,
    SENTRY_ORG: process.env.SENTRY_ORG,
    SENTRY_PROJECT: process.env.SENTRY_PROJECT,
    SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT,

    CRON_SECRET: process.env.CRON_SECRET,

    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_ANALYTICS_ID: process.env.NEXT_PUBLIC_ANALYTICS_ID,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  },
  emptyStringAsUndefined: true,
});
