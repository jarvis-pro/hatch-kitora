import { useTranslations } from 'next-intl';

import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/routing';

export function SiteHeader() {
  const t = useTranslations('marketing.nav');

  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="container flex h-14 items-center gap-6">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Kitora
        </Link>
        <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
          <Link href="/pricing" className="transition-colors hover:text-foreground">
            {t('pricing')}
          </Link>
          <a
            href="https://github.com"
            className="transition-colors hover:text-foreground"
            target="_blank"
            rel="noreferrer"
          >
            {t('github')}
          </a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <LocaleSwitcher />
          <ThemeToggle />
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href="/login">{t('signin')}</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/signup">{t('signup')}</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
