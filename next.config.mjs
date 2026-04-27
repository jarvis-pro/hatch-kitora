import { withSentryConfig } from '@sentry/nextjs';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const securityHeaders = [
  {
    key: 'X-DNS-Prefetch-Control',
    value: 'on',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'X-Frame-Options',
    value: 'SAMEORIGIN',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  // 仅在明确指定时（Docker 构建）才输出 standalone server bundle。
  // Vercel 和 `next start` 不需要它，standalone 模式会干扰
  // `pnpm start`（报警告）和 Sentry 的 build-trace 收集器。
  output: process.env.BUILD_STANDALONE === '1' ? 'standalone' : undefined,
  // 让这些包保持在服务端 webpack bundle 之外 —— 它们自带运行时解析逻辑，
  // webpack 打包后会破坏其正常运行。
  // （Next 15+ 此选项已重命名为 `serverExternalPackages`。）
  experimental: {
    // 把这些包保持在服务端 webpack bundle 之外。它们内部走动态 require
    // 或带可选 native 依赖（typeorm 的 mysql/sap-hana/react-native 驱动、
    // mongodb 的 aws4），打包后会触发一堆 "Critical dependency" 警告。
    serverComponentsExternalPackages: [
      'pino',
      'pino-pretty',
      '@prisma/client',
      '@boxyhq/saml-jackson',
      'typeorm',
      'mongodb',
    ],
    serverActions: {
      bodySizeLimit: '2mb',
    },
    // Next 14 中 @sentry/nextjs 加载 `src/instrumentation.ts` 所必须。
    // （Next 15+ 已稳定，该选项在 15+ 中被移除。）
    instrumentationHook: true,
  },
  // typeorm / mongodb 列出了一堆只在特定运行时/数据库下才需要的可选依赖
  // （react-native、SAP HANA、MySQL、AWS4 签名）。我们都不用，让 webpack
  // 直接忽略它们的 require，避免 "Module not found" 警告刷屏。
  webpack: (config, { webpack }) => {
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^(react-native-sqlite-storage|@sap\/hana-client(\/.*)?|mysql|aws4)$/,
      }),
    );
    return config;
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'avatars.githubusercontent.com' },
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
    ],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
};

// Sentry 应该包裹最外层的 config —— 这样它才能在所有插件产出之上注入
// 构建时能力（堆栈帧剥离、source map 上传）。只有当 auth token 存在时
// 才传入 `org`/`project`，否则 source map 上传步骤会静默跳过。
const sentryUploadConfigured = !!(
  process.env.SENTRY_AUTH_TOKEN &&
  process.env.SENTRY_ORG &&
  process.env.SENTRY_PROJECT
);

export default withSentryConfig(withNextIntl(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  hideSourceMaps: true,
  disableLogger: true,
  // auth token / org / project 缺失时静默 noop —— 保持 fork 和
  // 没有 Sentry 账号的 OSS 用户构建通过。
  sourcemaps: sentryUploadConfigured ? { disable: false } : { disable: true },
  // 浏览器 SDK 请求通过本应用隧道转发，绕过广告拦截器。
  tunnelRoute: '/monitoring',
});
