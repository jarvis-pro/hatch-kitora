import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/routing';
import { isCnRegion } from '@/lib/region';

export const metadata: Metadata = {
  title: '行使个人信息权利 / Exercise Your Data Rights',
};

/**
 * RFC 0006 §3.4 / §8.3 — PIPL §44 right-of-access landing page.
 *
 * Mainland-China only. PIPL Article 44 names four data rights every
 * processor must surface: query, correct, delete, port. We don't need
 * new machinery to honour them — RFC 0001/0002/0005 already shipped the
 * underlying flows. This page is the single sanctioned entry point that
 * regulators / users can hit to find them in 5 clicks or less, which is
 * how 2024+ MIIT spot-checks score "compliant UX".
 *
 * Returns 404 outside CN region so global deploys don't leak an empty
 * page (mirror of `/icp`).
 */
export default async function DataRightsPage() {
  if (!isCnRegion()) notFound();
  const t = await getTranslations('marketing.dataRights');

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
