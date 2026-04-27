import type { MetadataRoute } from 'next';

import { env } from '@/env';

/**
 * robots.txt 文件生成器。
 *
 * 定义搜索引擎爬虫访问规则，禁止索引 API、仪表板和设置等私密区域。
 *
 * @returns robots.txt 元数据
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // 禁止爬虫访问 API 端点、用户仪表板和设置页面
        disallow: ['/api/', '/dashboard/', '/settings/'],
      },
    ],
    sitemap: `${env.NEXT_PUBLIC_APP_URL}/sitemap.xml`,
  };
}
