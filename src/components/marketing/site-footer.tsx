import { useTranslations } from 'next-intl';

export function SiteFooter() {
  const t = useTranslations('marketing.footer');
  const year = new Date().getFullYear();

  return (
    <footer className="border-t">
      <div className="container flex flex-col items-center justify-between gap-2 py-6 text-sm text-muted-foreground md:flex-row">
        <p>© {year} Kitora. {t('rights')}</p>
        <p>{t('built')}</p>
      </div>
    </footer>
  );
}
