import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { env } from '@/env';
import { isCnRegion } from '@/lib/region';

export const metadata: Metadata = {
  title: 'ICP 备案 / Public Security Filing',
};

/**
 * 适用于中国大陆部署的合规落地页，展示 ICP 备案号和公安部备案信息。
 * 在 CN 以外的 region 返回 404，避免 `global` 部署暴露空页面。
 */
export default function IcpPage() {
  if (!isCnRegion()) notFound();
  const t = useTranslations('marketing.icp');

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
