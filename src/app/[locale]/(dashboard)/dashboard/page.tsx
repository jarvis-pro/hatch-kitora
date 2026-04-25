import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { auth } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'Dashboard',
};

export default async function DashboardPage() {
  const [session, t] = await Promise.all([auth(), getTranslations('dashboard.home')]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t('greeting', { name: session?.user?.name ?? t('friend') })}
        </h1>
        <p className="text-muted-foreground">{t('subtitle')}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Stat label={t('stats.users')} value="0" />
        <Stat label={t('stats.revenue')} value="$0" />
        <Stat label={t('stats.activity')} value="0" />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-3xl font-bold">{value}</p>
    </div>
  );
}
