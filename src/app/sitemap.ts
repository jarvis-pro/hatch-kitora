import type { MetadataRoute } from 'next';

import { env } from '@/env';
import { routing } from '@/i18n/routing';

const staticPaths = ['', '/pricing', '/login', '/signup'];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = env.NEXT_PUBLIC_APP_URL;
  const now = new Date();

  return staticPaths.flatMap((path) =>
    routing.locales.map((locale) => ({
      url: `${base}/${locale}${path}`,
      lastModified: now,
      changeFrequency: 'weekly' as const,
      priority: path === '' ? 1 : 0.7,
    })),
  );
}
