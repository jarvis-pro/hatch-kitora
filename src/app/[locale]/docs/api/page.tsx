import type { Metadata } from 'next';

import { ApiReferenceClient } from './_components/api-reference-client';

/**
 * RFC 0003 PR-3 — `/{locale}/docs/api` Scalar API 参考页面。
 *
 * 公开访问，无需认证，无顶部/底部导航（Scalar 自带导航）。
 * 本页面是直通包装层，使 `'use client'` 边界保持在 `<ApiReferenceClient />` 之下，
 * 后续如需添加服务端渲染的 metadata + JSON-LD 以满足 SEO 需求也不受影响。
 */

export const metadata: Metadata = {
  title: 'API Reference',
  description:
    'Kitora REST API — handwritten OpenAPI 3.1 specification covering authentication, webhooks, and account introspection.',
  openGraph: {
    title: 'Kitora API Reference',
    description: 'OpenAPI 3.1 specification for the Kitora SaaS platform.',
  },
  robots: {
    index: true,
    follow: true,
  },
};

// Scalar 在运行时动态抓取规范并渲染 —— 保持页面动态，避免路由处理器被静态预烘焙为 HTML。
export const dynamic = 'force-dynamic';

export default function ApiReferencePage() {
  return (
    <div className="h-screen w-full">
      <ApiReferenceClient />
    </div>
  );
}
