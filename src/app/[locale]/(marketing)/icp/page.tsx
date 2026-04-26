import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { env } from '@/env';
import { isCnRegion } from '@/lib/region';

export const metadata: Metadata = {
  title: 'ICP 备案 / Public Security Filing',
};

/**
 * Compliance landing page for mainland-China deployments. Surfaces the
 * ICP filing number and 公安部 record. Returns 404 outside CN region so
 * `global` deployments don't leak an empty page.
 */
export default async function IcpPage() {
  if (!isCnRegion()) notFound();
  const t = await getTranslations('marketing.icp');

  return (
    <div className="container max-w-2xl py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="mt-3 text-muted-foreground">{t('subtitle')}</p>

      <dl className="mt-8 space-y-6">
        <div>
          <dt className="text-sm font-medium text-muted-foreground">{t('icpLabel')}</dt>
          <dd className="mt-1 font-mono text-lg">{env.ICP_NUMBER ?? '—'}</dd>
        </div>
        {env.PUBLIC_SECURITY_NUMBER ? (
          <div>
            <dt className="text-sm font-medium text-muted-foreground">{t('mpsLabel')}</dt>
            <dd className="mt-1 font-mono text-lg">{env.PUBLIC_SECURITY_NUMBER}</dd>
          </div>
        ) : null}
      </dl>

      <p className="mt-10 text-sm text-muted-foreground">
        {t.rich('disclosure', {
          link: (chunks) => (
            <a
              href="https://beian.miit.gov.cn/"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-foreground"
            >
              {chunks}
            </a>
          ),
        })}
      </p>
    </div>
  );
}
