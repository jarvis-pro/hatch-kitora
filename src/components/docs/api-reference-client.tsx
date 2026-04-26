'use client';

import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';

/**
 * RFC 0003 PR-3 — Scalar reference renderer.
 *
 * Scalar's React component isn't SSR-safe (touches `window` during render),
 * so we hide it behind a `'use client'` boundary and let it fetch the spec
 * from `/api/openapi/v1.yaml` on mount. That route is `force-static` with
 * an hourly revalidate, so the cost amortizes to near-zero in production.
 *
 * The `theme: 'default'` + `layout: 'modern'` combo is intentionally close
 * to Scalar's homepage demo — looks polished without bespoke CSS, dark
 * mode follows the site theme via the `.dark` class their stylesheet keys
 * off of.
 */
export function ApiReferenceClient() {
  return (
    <ApiReferenceReact
      configuration={{
        spec: { url: '/api/openapi/v1.yaml' },
        theme: 'default',
        layout: 'modern',
        hideClientButton: false,
        hiddenClients: [],
        defaultHttpClient: {
          targetKey: 'shell',
          clientKey: 'curl',
        },
        metaData: {
          title: 'Kitora API Reference',
        },
      }}
    />
  );
}
