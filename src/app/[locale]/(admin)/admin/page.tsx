import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { MetricCard } from '@/components/admin/metric-card';
import { getAdminMetrics } from '@/lib/admin/metrics';

export const metadata: Metadata = {
  title: 'Admin · Overview',
};

// Always fetch fresh — admin metrics shouldn't be statically cached.
export const dynamic = 'force-dynamic';

function formatUsd(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export default async function AdminOverviewPage() {
  const t = await getTranslations('admin.overview');
  const metrics = await getAdminMetrics();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label={t('cards.totalUsers')} value={metrics.totalUsers.toLocaleString()} />
        <MetricCard
          label={t('cards.newUsers')}
          value={metrics.newUsersLast7d.toLocaleString()}
          hint={t('cards.newUsersHint')}
        />
        <MetricCard
          label={t('cards.activeSubs')}
          value={metrics.activeSubscriptions.toLocaleString()}
        />
        <MetricCard
          label={t('cards.mrr')}
          value={formatUsd(metrics.approxMrrCents)}
          hint={t('cards.mrrHint')}
        />
      </div>
    </div>
  );
}
