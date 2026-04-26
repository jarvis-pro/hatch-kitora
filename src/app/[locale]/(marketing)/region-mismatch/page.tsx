import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/routing';

export const metadata: Metadata = {
  title: 'Wrong region',
};

interface Props {
  searchParams: Promise<{ expected?: string }>;
}

const REGION_HOMES: Record<string, { url: string; label: string }> = {
  GLOBAL: { url: 'https://kitora.io', label: 'kitora.io' },
  CN: { url: 'https://kitora.cn', label: 'kitora.cn' },
  EU: { url: 'https://kitora.eu', label: 'kitora.eu' },
};

/**
 * RFC 0005 — landing page for cross-region session bounces.
 *
 * Hit when a logged-in session carrying `userRegion=X` lands on a stack
 * serving region `Y`. Should never happen in production (cookies don't
 * cross domains), but we keep a friendly explainer page for debugging
 * and as a defence-in-depth signal that the guard fired.
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
