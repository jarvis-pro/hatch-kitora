import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

/**
 * 环境变量验证与管理。
 *
 * 使用 T3 Env 和 Zod schema 在运行时验证环境变量类型和值，
 * 分离服务端、客户端和共享变量，确保类型安全和防止数据泄漏。
 */
export const env = createEnv({
  server: {
    /**
     * 当前运行环境。
     * - 'development' — 本地开发
     * - 'test' — 测试或 CI 环境
     * - 'production' — 生产环境
     */
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // ===== 数据库配置 =====
    /**
     * Prisma 数据库连接字符串（可包含连接池）。
     * 格式：postgresql://user:password@host:port/database
     */
    DATABASE_URL: z.string().url(),
    /**
     * 直接数据库连接 URL（绕过连接池）。
     * 用于长连接场景（如 Prisma Migrate）；可选。
     */
    DIRECT_URL: z.string().url().optional(),

    // ===== Auth.js 认证配置 =====
    /**
     * Auth.js 密钥，用于加密会话 JWT。必须 >= 32 字符。
     * 生成：openssl rand -base64 32
     */
    AUTH_SECRET: z.string().min(32, '必须至少 32 个字符'),
    /**
     * Auth.js 回调 URL。在生产环境需显式设置；
     * 开发环境通常从 NEXT_PUBLIC_APP_URL 自动推导。
     */
    AUTH_URL: z.string().url().optional(),

    // ===== OAuth 提供商（初始开发可选）=====
    /**
     * GitHub OAuth App ID。
     */
    AUTH_GITHUB_ID: z.string().optional(),
    /**
     * GitHub OAuth App Secret。
     */
    AUTH_GITHUB_SECRET: z.string().optional(),
    /**
     * Google OAuth 应用 ID。
     */
    AUTH_GOOGLE_ID: z.string().optional(),
    /**
     * Google OAuth 应用 Secret。
     */
    AUTH_GOOGLE_SECRET: z.string().optional(),

    // ===== Stripe 支付配置 =====
    /**
     * Stripe 后端 API 密钥（sk_live_ 或 sk_test_）。
     */
    STRIPE_SECRET_KEY: z.string().optional(),
    /**
     * Stripe Webhook 签名密钥，用于验证 Webhook 真实性。
     */
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    /**
     * Stripe Pro 定价 ID（price_*）。
     */
    STRIPE_PRO_PRICE_ID: z.string().optional(),
    /**
     * Stripe Team 定价 ID（price_*）。
     */
    STRIPE_TEAM_PRICE_ID: z.string().optional(),

    // ===== 电子邮件配置 =====
    /**
     * Resend 电子邮件服务 API 密钥（用于事务性邮件）。
     */
    RESEND_API_KEY: z.string().optional(),
    /**
     * 发送者邮件地址。接受两种格式：
     * - 纯地址：a@b.com
     * - RFC 5322 格式："Name <a@b.com>"（Resend / SendGrid / SMTP 推荐）
     */
    EMAIL_FROM: z
      .string()
      .refine(
        (v) =>
          /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(v) ||
          /^"?[^<>"]+?"?\s*<\s*[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+\s*>$/.test(v),
        { message: '格式错误：需为 a@b.com 或 "Name <a@b.com>" 形式' },
      )
      .default('Kitora <onboarding@example.com>'),

    // ===== Redis 速率限制（全球地区）=====
    /**
     * Upstash Redis REST API 端点 URL。
     * 用于全球部署的速率限制；中国地区改用 ALIYUN_REDIS_URL。
     */
    UPSTASH_REDIS_REST_URL: z.string().url().optional(),
    /**
     * Upstash Redis 访问令牌。
     */
    UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

    // ===== RFC 0005 — 多区域部署配置 =====
    /**
     * 规范的部署区域标识符。值为大写：
     * - 'GLOBAL' — 全球部署
     * - 'CN' — 中国大陆部署
     * - 'EU' — 欧洲部署
     *
     * 应通过 `src/lib/region.ts` 的 `currentRegion()` 读取，不直接用 process.env。
     * 中间件在 Edge 运行时内联复制解析逻辑。
     */
    KITORA_REGION: z.enum(['GLOBAL', 'CN', 'EU']).optional(),
    /**
     * 已弃用的区域变量（向后兼容）。小写值：'global' 或 'cn'。
     * 当 KITORA_REGION 和 REGION 都设置时，KITORA_REGION 优先。
     * 首次回退到遗留变量时将触发警告日志，提示运营商迁移。
     */
    REGION: z.enum(['global', 'cn']).optional(),

    // ===== 中国大陆合规配置 =====
    /**
     * ICP 备案号。仅在中国部署时需要，显示于页脚以满足工信部要求。
     * 全球部署留空。
     */
    ICP_NUMBER: z.string().optional(),
    /**
     * 公安部网络安全备案号。仅在中国部署时需要，显示于页脚。
     * 全球部署留空。
     */
    PUBLIC_SECURITY_NUMBER: z.string().optional(),

    // ===== RFC 0006 PR-2 — 阿里云基础设施凭证（中国部署）=====
    /**
     * 阿里云账户 AccessKey ID。由 OSS 和 DirectMail 共享。
     * 所有阿里云变量在 env 层为可选（dev / GLOBAL 堆栈无需配置），
     * 但在中国部署时由提供商本身在缺少凭证时抛出配置错误。
     *
     * 生产环境推荐使用 STS 支持的 RAM 角色（绑定 ACK 服务账户）；
     * 本地 dev 仅需对沙箱账户填充此项。
     */
    ALIYUN_ACCESS_KEY_ID: z.string().optional(),
    /**
     * 阿里云账户 AccessKey Secret。
     */
    ALIYUN_ACCESS_KEY_SECRET: z.string().optional(),

    // ===== 阿里云 OSS（对象存储）配置 =====
    /**
     * OSS Bucket 名称。
     */
    ALIYUN_OSS_BUCKET: z.string().optional(),
    /**
     * OSS 区域代码，例如 'cn-shanghai'。
     */
    ALIYUN_OSS_REGION: z.string().optional(),
    /**
     * OSS 自定义端点 URL。仅在使用非默认端点时设置，
     * 例如 VPC 内部端点 `oss-cn-shanghai-internal.aliyuncs.com`
     * 用于 ACK→OSS 内网流量。
     */
    ALIYUN_OSS_ENDPOINT: z.string().url().optional(),

    // ===== 阿里云 DirectMail（事务性邮件）配置 =====
    /**
     * DirectMail 已验证的发送方地址（Account Name）。
     */
    ALIYUN_DM_ACCOUNT_NAME: z.string().optional(),
    /**
     * DirectMail API 地区端点，例如 'dm.cn-hangzhou.aliyuncs.com'。
     * 注意：DirectMail 地区可能与 OSS / RDS 地区不同；
     * cn-hangzhou 是中国大陆的规范端点。
     */
    ALIYUN_DM_ENDPOINT: z.string().optional(),

    // ===== 阿里云 Redis（中国部署速率限制）=====
    /**
     * 阿里云 Redis TCP 协议连接 URL。中国部署时由 `src/lib/rate-limit.ts`
     * 在 `currentRegion()` 为 'CN' 时自动使用，替代 Upstash REST
     * （Upstash 位于 GFW 外，往返延迟 >200ms 在热路径上不可接受）。
     *
     * 格式：
     * - redis://:{password}@{host}:6379（标准端口）
     * - rediss://:{password}@{host}:6380（TLS 加密端口）
     *
     * 应在 VPC 内部解析，不应暴露为公网端点。
     */
    ALIYUN_REDIS_URL: z.string().optional(),

    // ===== RFC 0006 PR-3 — 中国支付凭证（支付宝 + 微信支付）=====
    /**
     * 所有支付凭证在 env 层为可选（dev / GLOBAL 堆栈无需配置），
     * 但在中国部署时由提供商本身在缺少凭证时抛出配置错误。
     */

    // ===== 支付宝支付配置（PC 网站支付 + 周期扣款）=====
    /**
     * 支付宝应用 ID（从蚂蚁金服开放平台获取）。
     */
    ALIPAY_APP_ID: z.string().optional(),
    /**
     * 支付宝应用私钥。格式：PKCS8 PEM，去除 BEGIN/END 头尾的一行字符串。
     */
    ALIPAY_PRIVATE_KEY: z.string().optional(),
    /**
     * 支付宝公钥。用于验证 Webhook 回调签名真实性。
     */
    ALIPAY_PUBLIC_KEY: z.string().optional(),
    /**
     * 支付宝 API 网关。
     * - 生产：https://openapi.alipay.com/gateway.do（默认）
     * - 沙箱：https://openapi-sandbox.alipay.com/gateway.do
     */
    ALIPAY_GATEWAY: z.string().url().default('https://openapi.alipay.com/gateway.do'),
    /**
     * 支付宝 Webhook notify_url 所用的公网 API 地址。
     * 中国区域推荐 https://api.kitora.cn（RFC 0006 §3.5）；
     * dev / staging 回退使用 NEXT_PUBLIC_APP_URL。
     */
    CN_PUBLIC_API_URL: z.string().url().optional(),

    // ===== 微信支付 APIv3 配置（Native 二维码 + 周期扣款）=====
    /**
     * 微信支付商户号（由微信支付分配）。
     */
    WECHAT_PAY_MCH_ID: z.string().optional(),
    /**
     * 微信支付 APIv3 密钥。用于 Webhook 回调的 AES-GCM 解密。
     */
    WECHAT_PAY_APIV3_KEY: z.string().optional(),
    /**
     * 微信支付商户证书私钥（PEM 格式）。
     */
    WECHAT_PAY_MERCHANT_PRIVATE_KEY: z.string().optional(),
    /**
     * 微信支付商户证书序列号。
     */
    WECHAT_PAY_MERCHANT_SERIAL_NO: z.string().optional(),
    /**
     * 微信公众号 / 服务号应用 ID。Native 扫码支付仍需此项。
     */
    WECHAT_PAY_APP_ID: z.string().optional(),
    /**
     * 向后兼容：已弃用的 APIv2 签名密钥名称。
     * v3 API 调用者应迁移至 WECHAT_PAY_APIV3_KEY。
     * 本项在弃用期内仍被接受，避免升级时校验失败。
     */
    WECHAT_PAY_API_KEY: z.string().optional(),

    // ===== 日志配置 =====
    /**
     * Pino 日志级别。值越低越详细。
     * - 'fatal' — 仅致命错误
     * - 'error' — 错误及以上
     * - 'warn' — 警告及以上
     * - 'info' — 信息及以上（默认）
     * - 'debug' — 调试信息
     * - 'trace' — 追踪级细节
     * - 'silent' — 禁用日志
     */
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // ===== RFC 0002 PR-3 — 用户数据导出配置 =====
    /**
     * 数据导出存储后端。Cron worker 将用户数据打包为 ZIP 工件后存储于此。
     * - 'local' — 本地文件系统（DATA_EXPORT_LOCAL_DIR）
     * - 's3' — Amazon S3 或兼容存储（需配置 bucket + region + 凭证）
     */
    DATA_EXPORT_STORAGE: z.enum(['local', 's3']).default('local'),
    /**
     * 本地导出存储目录（'local' 模式）。默认 ./tmp/exports（git 忽略）。
     */
    DATA_EXPORT_LOCAL_DIR: z.string().default('./tmp/exports'),
    /**
     * S3 Bucket 名称（'s3' 模式）。
     */
    DATA_EXPORT_S3_BUCKET: z.string().optional(),
    /**
     * S3 Bucket 区域代码，例如 'us-east-1'。
     */
    DATA_EXPORT_S3_REGION: z.string().optional(),
    /**
     * S3 访问密钥 ID（AWS 或兼容提供商）。
     */
    DATA_EXPORT_S3_ACCESS_KEY_ID: z.string().optional(),
    /**
     * S3 访问密钥 Secret。下载时服务端生成签名 URL 供用户使用。
     */
    DATA_EXPORT_S3_SECRET_ACCESS_KEY: z.string().optional(),

    // ===== RFC 0007 — WebAuthn / Passkey 配置 =====
    /**
     * Relying Party ID（依赖方 ID）。凭据绑定到的 eTLD+1 域名。
     * 必须与浏览器文档主机名精确匹配。
     * - 生产通常设为 'kitora.io' / 'kitora.cn' / 'kitora.eu'
     * - Dev / e2e 可留空，自动回退到 URL 主机名
     */
    WEBAUTHN_RP_ID: z.string().optional(),
    /**
     * Relying Party 显示名称。在用户同意对话框中显示。默认 'Kitora'。
     */
    WEBAUTHN_RP_NAME: z.string().optional(),
    /**
     * WebAuthn 完整源（scheme + host + port）。默认为 NEXT_PUBLIC_APP_URL。
     * 在反向代理背后（公网主机名与 NEXT_PUBLIC_APP_URL 不同）时需明确设置。
     */
    WEBAUTHN_ORIGIN: z.string().url().optional(),

    // ===== Sentry 错误跟踪配置 =====
    /**
     * Sentry Auth Token。服务端构建时用于上传源地图。所有项可选；
     * 缺少值仅禁用相应功能，不影响应用运行。
     */
    SENTRY_AUTH_TOKEN: z.string().optional(),
    /**
     * Sentry 组织标识符。
     */
    SENTRY_ORG: z.string().optional(),
    /**
     * Sentry 项目标识符。
     */
    SENTRY_PROJECT: z.string().optional(),
    /**
     * Sentry 环境标签（development / staging / production）。
     */
    SENTRY_ENVIRONMENT: z.string().optional(),

    // ===== RFC 0008 PR-4 — Vercel Cron 后台任务密钥 =====
    /**
     * Cron 认证密钥。用于保护 `/api/jobs/tick` Webhook 端点。
     *
     * Vercel Cron 调度器在请求中自动注入 `Authorization: Bearer ${CRON_SECRET}` header。
     * 外部直接访问时返回 401（不泄露路径存在性，沿用 RFC 0003 webhook 模式）。
     *
     * 生产环境必须配置 >= 32 字符的强随机字符串：
     *   openssl rand -base64 32
     *
     * Dev / e2e 非强制：
     * - Route 自身在未配置时 503 short-circuit（「cron-not-configured」）
     * - CLI 脚本 `pnpm tsx scripts/run-jobs.ts` 不走 HTTP，完全无影响
     */
    CRON_SECRET: z.string().min(32).optional(),
  },
  /**
   * 客户端暴露的环境变量。
   * 这些变量会打包进浏览器 JS bundle，用户可见，不应包含敏感信息。
   */
  client: {
    /**
     * 应用完整 URL（scheme + host + port）。
     * 用于链接生成、API 回调 URL 等。开发环境默认 http://localhost:3000。
     */
    NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
    /**
     * 应用显示名称。用于页面标题、按钮标签等 UI 文本。
     */
    NEXT_PUBLIC_APP_NAME: z.string().default('Kitora'),
    /**
     * 分析/追踪平台 ID（如 Google Analytics GA4 测量 ID）。
     */
    NEXT_PUBLIC_ANALYTICS_ID: z.string().optional(),
    /**
     * Sentry 客户端 DSN。暴露给浏览器用于前端错误上报。
     * 留空或不设置则禁用浏览器 Sentry 集成。
     */
    NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  },
  /**
   * 运行时环境变量映射。
   * 将 process.env 中的变量映射到验证后的 env 对象中。
   */
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
  /**
   * 配置：将空字符串视为 undefined。
   * 防止空 env 变量（如 `.env` 中 `FOO=`）被解析为空字符串。
   */
  emptyStringAsUndefined: true,
});
