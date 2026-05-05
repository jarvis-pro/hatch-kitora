import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Link } from '@/i18n/routing';
import { isCnRegion } from '@/lib/region';

export const metadata: Metadata = {
  title: '行使个人信息权利 / Exercise Your Data Rights',
};

/**
 * PIPL §44 数据权利访问登录页。
 *
 * 仅限中国大陆。PIPL 第 44 条列举了处理器必须提供的四项数据权利：查询、更正、删除、转移。
 * 此页是单一授权入口点，监管机构/用户可以通过 5 次点击找到这些权利，
 * 这是 2024+ MIIT 抽查判定"符合 UX"的方式。
 *
 * 在 CN 区域外返回 404，以便全局部署不会泄露空页面（与 `/icp` 相同）。
 */
export default function DataRightsPage() {
  if (!isCnRegion()) notFound();
  const t = useTranslations('marketing.dataRights');

  const cards = [
    {
      key: 'query',
      title: t('query.title'),
      desc: t('query.desc'),
      href: '/settings',
      cta: t('query.cta'),
    },
    {
      key: 'correct',
      title: t('correct.title'),
      desc: t('correct.desc'),
      href: '/settings',
      cta: t('correct.cta'),
    },
    {
      key: 'delete',
      title: t('delete.title'),
      desc: t('delete.desc'),
      href: '/settings',
      cta: t('delete.cta'),
    },
    {
      key: 'export',
      title: t('export.title'),
      desc: t('export.desc'),
      href: '/settings',
      cta: t('export.cta'),
    },
  ];

  return (
    <div className="container max-w-3xl py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="mt-3 text-muted-foreground">{t('subtitle')}</p>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {cards.map((c) => (
          <div key={c.key} className="rounded-lg border p-5">
            <h2 className="text-lg font-medium">{c.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{c.desc}</p>
            <Link
              href={c.href}
              className="mt-4 inline-block text-sm font-medium underline-offset-2 hover:underline"
            >
              {c.cta} →
            </Link>
          </div>
        ))}
      </div>

      <p className="mt-10 text-sm text-muted-foreground">{t('contact')}</p>
    </div>
  );
}
