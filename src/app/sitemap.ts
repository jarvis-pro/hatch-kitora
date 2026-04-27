import type { MetadataRoute } from 'next';

import { env } from '@/env';
import { routing } from '@/i18n/routing';

// 站点内可被索引的静态页面路由列表
const staticPaths = ['', '/pricing', '/login', '/signup'];

/**
 * sitemap.xml 文件生成器。
 *
 * 为搜索引擎提供所有可索引页面的列表。
 * 为每个支持的语言生成 URL 条目。
 * 首页优先级最高，其他页面次之。
 *
 * @returns sitemap.xml 元数据
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = env.NEXT_PUBLIC_APP_URL;
  const now = new Date();

  // 为每个静态路径和每个语言区域生成 sitemap 条目
  return staticPaths.flatMap((path) =>
    routing.locales.map((locale) => ({
      url: `${base}/${locale}${path}`,
      lastModified: now,
      changeFrequency: 'weekly' as const,
      // 首页（空路径）优先级为 1.0，其他页面为 0.7
      priority: path === '' ? 1 : 0.7,
    })),
  );
}
