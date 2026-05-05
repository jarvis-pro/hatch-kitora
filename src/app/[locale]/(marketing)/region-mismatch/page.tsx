import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { Link, type Locale } from '@/i18n/routing';

interface Props {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ expected?: string }>;
}

export async function generateMetadata({ params }: { params: Props['params'] }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'marketing.regionMismatch' });
  return { title: t('metaTitle') };
}

const REGION_HOMES: Record<string, { url: string; label: string }> = {
  GLOBAL: { url: 'https://kitora.io', label: 'kitora.io' },
  CN: { url: 'https://kitora.cn', label: 'kitora.cn' },
  EU: { url: 'https://kitora.eu', label: 'kitora.eu' },
};

/**
 * 跨 region session 跳转的落地页。
 *
 * 当携带 `userRegion=X` 的已登录 session 落地到服务 region `Y` 的实例时触发。
 * 生产环境下理论上不会发生（Cookie 不跨域），但保留此友好说明页
 * 用于调试，也作为守卫已触发的深度防御信号。
 */
export default async function RegionMismatchPage({ searchParams }: Props) {
  const { expected } = await searchParams;
  const t = await getTranslations('marketing.regionMismatch');
  const target = expected ? REGION_HOMES[expected] : undefined;

  return (
    <div className="container max-w-2xl py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="mt-3 text-muted-foreground">{t('subtitle')}</p>

      {target ? (
        <p className="mt-8">
          {t.rich('go', {
            name: target.label,
            link: (chunks) => (
              <a href={target.url} className="font-medium underline hover:text-foreground">
                {chunks}
              </a>
            ),
          })}
        </p>
      ) : (
        <p className="mt-8 text-muted-foreground">{t('noTarget')}</p>
      )}

      <p className="mt-10 text-sm text-muted-foreground">
        <Link href="/" className="underline hover:text-foreground">
          {t('home')}
        </Link>
      </p>
    </div>
  );
}
