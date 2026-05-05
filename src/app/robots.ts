import type { MetadataRoute } from 'next';

import { env } from '@/env';
import { routing } from '@/i18n/routing';

/**
 * 受保护路由段，与 middleware.ts 的 PROTECTED 正则保持语义一致。
 * 这些路径需要认证，对搜索引擎索引无价值且会暴露内部结构。
 */
const PROTECTED_PATHS = ['dashboard', 'settings', 'admin'] as const;

/**
 * robots.txt 文件生成器。
 *
 * 禁止索引 API 端点与所有受保护路由（自动展开 locale 前缀变体）。
 * disallow 列表由 routing.locales 派生，新增 locale 时无需手动同步。
 *
 * @returns robots.txt 元数据
 */
export default function robots(): MetadataRoute.Robots {
  // localePrefix: 'as-needed' — 默认 locale 无前缀，其余带 /{locale}
  const localePrefixes = [
    '',
    ...routing.locales.filter((l) => l !== routing.defaultLocale).map((l) => `/${l}`),
  ];

  const disallow = [
    '/api/',
    ...PROTECTED_PATHS.flatMap((p) => localePrefixes.map((prefix) => `${prefix}/${p}/`)),
  ];

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow,
      },
    ],
    sitemap: `${env.NEXT_PUBLIC_APP_URL}/sitemap.xml`,
  };
}
