import type { MetadataRoute } from 'next';

import { env } from '@/env';
import { routing } from '@/i18n/routing';

type SitemapEntry = MetadataRoute.Sitemap[number];

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
    routing.locales.map<SitemapEntry>((locale) => ({
      // 完整绝对 URL — sitemap 协议要求 absolute，相对路径无效
      url: `${base}/${locale}${path}`,
      // 资源最后修改时间 — 爬虫据此判断是否重新抓取（增量抓取的依据）
      lastModified: now,
      // 预期更新频率提示（hint）— always / hourly / daily / weekly / monthly / yearly / never
      // 仅供参考，主流爬虫（含 Googlebot）不严格遵守，但仍是抓取预算分配的弱信号
      changeFrequency: 'weekly',
      // 站内相对优先级 0.0–1.0 — 仅影响同域内的抓取顺序，不影响搜索排名
      // 首页设 1.0 标记主入口，其他静态页降到 0.7 表明次要
      priority: path === '' ? 1 : 0.7,
    })),
  );
}
