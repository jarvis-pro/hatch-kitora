'use client';

import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';

/**
 * RFC 0003 PR-3 — Scalar 参考渲染器。
 *
 * Scalar 的 React 组件不是 SSR 安全的（在渲染期间触及 `window`），
 * 所以我们将其隐藏在 `'use client'` 边界后面，让它在挂载时从
 * `/api/openapi/v1.yaml` 获取规范。该路由是 `force-static` 的，
 * 具有每小时重新验证，因此成本在生产中摊销到接近零。
 *
 * `theme: 'default'` + `layout: 'modern'` 组合有意接近
 * Scalar 的主页演示 — 看起来光泽，无需定制 CSS，暗色
 * 模式通过其样式表键入的 `.dark` 类跟随网站主题。
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
