import type { Metadata } from 'next';

import { ApiReferenceClient } from '@/components/docs/api-reference-client';

/**
 * RFC 0003 PR-3 — `/{locale}/docs/api` Scalar API reference page.
 *
 * Public — no auth, no nav header / footer chrome (Scalar provides its own
 * navigation). The page is a pass-through wrapper so the `'use client'`
 * boundary stays under `<ApiReferenceClient />`, leaving us free to add
 * server-rendered metadata + JSON-LD if SEO ever wants it.
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

// Scalar fetches the spec at runtime and renders interactively — keep the
// page dynamic so the route handler isn't statically pre-baked into HTML.
export const dynamic = 'force-dynamic';

export default function ApiReferencePage() {
  return (
    <div className="h-screen w-full">
      <ApiReferenceClient />
    </div>
  );
}
