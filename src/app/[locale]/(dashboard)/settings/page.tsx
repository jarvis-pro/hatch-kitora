import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

export const metadata: Metadata = {
  title: 'Settings',
};

export default async function SettingsPage() {
  const t = await getTranslations('dashboard.settings');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground">{t('subtitle')}</p>
      </div>
      <div className="rounded-xl border bg-card p-6 text-sm text-muted-foreground shadow-sm">
        {t('placeholder')}
      </div>
    </div>
  );
}
