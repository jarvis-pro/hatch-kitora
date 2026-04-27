import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // 数据库
    DATABASE_URL: z.string().url(),
    DIRECT_URL: z.string().url().optional(),

    // Auth.js
    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
    AUTH_URL: z.string().url().optional(),

    // OAuth 提供商（初始开发期间可选）
    AUTH_GITHUB_ID: z.string().optional(),
    AUTH_GITHUB_SECRET: z.string().optional(),
    AUTH_GOOGLE_ID: z.string().optional(),
    AUTH_GOOGLE_SECRET: z.string().optional(),

    // Stripe
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_PRO_PRICE_ID: z.string().optional(),
    STRIPE_TEAM_PRICE_ID: z.string().optional(),

    // 电子邮件 — 接受纯地址（`a@b.com`）或 RFC 5322
    // "Name <a@b.com>" 发送方格式（由 Resend / SendGrid / SMTP 使用）。
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

    // Upstash Redis（速率限制）
    UPSTASH_REDIS_REST_URL: z.string().url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

    // RFC 0005 — 多区域。`KITORA_REGION` 是规范名称，
    // 其值为大写以与 Prisma `Region` 枚举对齐
    // （GLOBAL / CN / EU）。它是进程范围的常量：通过
    // `src/lib/region.ts` 中的 `currentRegion()` 读取，
    // 永不直接通过 `process.env`。
    //
    // 小写的 `REGION` 在一个弃用窗口内被接受
    // （v0.6 + v0.7 接受它作为别名；v0.8 移除读取）。
    // 当两者都设置时，`KITORA_REGION` 获胜。第一次
    // `currentRegion()` 回退到遗留变量时触发 `logger.warn`，
    // 以便运营商看到迁移提示。
    KITORA_REGION: z.enum(['GLOBAL', 'CN', 'EU']).optional(),
    REGION: z.enum(['global', 'cn']).optional(),

    // 仅限中国大陆：在页脚中显示以满足 ICP / 公安部备案
    // 要求。在"global"模式中两者都留空。
    ICP_NUMBER: z.string().optional(),
    PUBLIC_SECURITY_NUMBER: z.string().optional(),

    // 中国基础设施凭证（RFC 0006 PR-2）。所有可选
    // 在 env 层以便 dev / GLOBAL 堆栈无需设置即可启动；
    // 提供商本身在中国区域请求到达且缺少匹配的凭证块时
    // 抛出配置错误。
    //
    // RAM AccessKey 由阿里云 OSS（对象存储）和 DirectMail
    // （事务性电子邮件）共享。生产使用 STS 支持的 RAM 角色
    // 绑定到 ACK 服务账户，因此这些 env 变量仅在本地 dev
    // 对沙箱账户时需要填充。
    ALIYUN_ACCESS_KEY_ID: z.string().optional(),
    ALIYUN_ACCESS_KEY_SECRET: z.string().optional(),

    // OSS — bucket + region（例如 cn-shanghai）。端点可选
    // 仅在使用非默认端点时设置（例如 VPC 内部
    // `oss-cn-shanghai-internal.aliyuncs.com` 用于 ACK→OSS 流量）。
    ALIYUN_OSS_BUCKET: z.string().optional(),
    ALIYUN_OSS_REGION: z.string().optional(),
    ALIYUN_OSS_ENDPOINT: z.string().url().optional(),

    // DirectMail — 已验证的发送方地址（DirectMail 术语中的
    // `AccountName`）和地区端点（例如
    // `dm.cn-hangzhou.aliyuncs.com`）。DirectMail 的地区可能
    // 与 OSS / RDS 地区不同；cn-hangzhou 是规范的大陆端点。
    ALIYUN_DM_ACCOUNT_NAME: z.string().optional(),
    ALIYUN_DM_ENDPOINT: z.string().optional(),

    // 阿里云 Redis — TCP 协议 Redis URL，由
    // `src/lib/rate-limit.ts` 在 `currentRegion()` 为 CN 时使用。
    // 在中国区域替换 Upstash REST（Upstash 位于 GFW 外，
    // RTT >200ms 在热路径上不可接受）。格式：`redis://:{password}@{host}:6379` 或
    // `rediss://...` 用于 TLS 端口 (6380)。应在 VPC 上解析，不是公共的。
    ALIYUN_REDIS_URL: z.string().optional(),

    // 中国支付凭证（RFC 0006 PR-3）。所有可选在 env 层
    // 以便 dev / GLOBAL 堆栈无需设置即可启动；提供商本身
    // 在中国区域请求到达且缺少匹配的凭证块时抛出配置错误。
    //
    // 支付宝 — 「电脑网站支付 + 周期扣款」需要四个部分：
    //   * APP_ID                — 应用 ID（从开放平台获取）
    //   * APP_PRIVATE_KEY       — 应用私钥（PKCS8, PEM 一行去掉 BEGIN/END）
    //   * ALIPAY_PUBLIC_KEY     — 支付宝公钥，用于回调验签
    //   * GATEWAY               — 默认正式网关；沙箱时换成 openapi-sandbox
    ALIPAY_APP_ID: z.string().optional(),
    ALIPAY_PRIVATE_KEY: z.string().optional(),
    ALIPAY_PUBLIC_KEY: z.string().optional(),
    ALIPAY_GATEWAY: z.string().url().default('https://openapi.alipay.com/gateway.do'),
    // Webhook 处理程序想要一个 stable 主机名用于 `notify_url`；
    // 在中国区域这是 `https://api.kitora.cn`（RFC 0006 §3.5）。
    // 回退使用 NEXT_PUBLIC_APP_URL 用于 dev / staging。
    CN_PUBLIC_API_URL: z.string().url().optional(),

    // 微信支付 APIv3 — Native 支付二维码模式 + 周期扣款 (papay)。
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
    // 向后兼容 — 旧名称 `WECHAT_PAY_API_KEY` 是 v2 签名密钥。
    // v3 调用者必须迁移到 `WECHAT_PAY_APIV3_KEY`。在一个弃用窗口
    // 内继续接受遗留名称，以便现有的 .env 文件在升级时不会验证失败。
    WECHAT_PAY_API_KEY: z.string().optional(),

    // 日志
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // 数据导出（RFC 0002 PR-3）— cron worker 放置已完成
    // zip 工件的位置。`local` 在 DATA_EXPORT_LOCAL_DIR 下写入
    //（默认为 ./tmp/exports — git-ignored）。`s3` 需要 bucket + region
    // 变量；签名 URL 在下载时生成。
    DATA_EXPORT_STORAGE: z.enum(['local', 's3']).default('local'),
    DATA_EXPORT_LOCAL_DIR: z.string().default('./tmp/exports'),
    DATA_EXPORT_S3_BUCKET: z.string().optional(),
    DATA_EXPORT_S3_REGION: z.string().optional(),
    DATA_EXPORT_S3_ACCESS_KEY_ID: z.string().optional(),
    DATA_EXPORT_S3_SECRET_ACCESS_KEY: z.string().optional(),

    // RFC 0007 — WebAuthn / Passkey 配置。所有可选；lib
    // 从 `NEXT_PUBLIC_APP_URL` 自动派生合理的默认值。
    // 在运行在反向代理后（其中公共主机名与
    // `NEXT_PUBLIC_APP_URL` 不同）时明确覆盖。
    //
    //   * RP_ID    — 凭据绑定到的 eTLD+1。必须与
    //                浏览器端的文档主机名匹配。生产通常
    //                将其设置为 `kitora.io` / `kitora.cn` / `kitora.eu`。
    //                Dev / e2e 可以留空 → 回退到 URL 主机。
    //   * RP_NAME  — 同意提示中的人类标签。默认 `Kitora`。
    //   * ORIGIN   — 完整源（scheme + host + port）。默认为
    //                `NEXT_PUBLIC_APP_URL`。
    WEBAUTHN_RP_ID: z.string().optional(),
    WEBAUTHN_RP_NAME: z.string().optional(),
    WEBAUTHN_ORIGIN: z.string().url().optional(),

    // Sentry — 服务端构建时变量用于源地图上传。运行时 DSN
    // 在客户端（NEXT_PUBLIC_SENTRY_DSN）。所有可选：缺少
    // 值只是禁用相关的集成。
    SENTRY_AUTH_TOKEN: z.string().optional(),
    SENTRY_ORG: z.string().optional(),
    SENTRY_PROJECT: z.string().optional(),
    SENTRY_ENVIRONMENT: z.string().optional(),

    // RFC 0008 PR-4 — 后台任务 Vercel Cron 认证密钥。
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
    /** 公共 DSN — 暴露给浏览器。空字符串禁用 Sentry。*/
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
