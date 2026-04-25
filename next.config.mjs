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
  // Only emit the standalone server bundle when explicitly requested (Docker
  // build). Vercel and `next start` don't need it, and standalone confuses
  // both `pnpm start` (warning) and Sentry's build-trace collector.
  output: process.env.BUILD_STANDALONE === '1' ? 'standalone' : undefined,
  // Keep these packages outside the webpack bundle on the server — they ship
  // their own runtime resolution that webpack would otherwise break.
  // (In Next 15+ this option is renamed to `serverExternalPackages`.)
  experimental: {
    serverComponentsExternalPackages: ['pino', 'pino-pretty', '@prisma/client'],
    serverActions: {
      bodySizeLimit: '2mb',
    },
    // Required by @sentry/nextjs in Next 14 to load `src/instrumentation.ts`.
    // (Stable in Next 15+ and removed there.)
    instrumentationHook: true,
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

// Sentry should wrap the outermost config — this lets it inject build-time
// instrumentation (stack-frame stripping, source-map upload) over whatever the
// other plugins produce. We only pass an `org`/`project` when the auth token
// is set, otherwise the source-map upload step is silently skipped.
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
  // No-op when auth token / org / project missing — keeps the build green
  // for forks and OSS users who don't have a Sentry account.
  sourcemaps: sentryUploadConfigured ? { disable: false } : { disable: true },
  // Tunnel browser SDK requests through this app, bypassing ad-blockers.
  tunnelRoute: '/monitoring',
});
