import { useTranslations } from 'next-intl';

import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/routing';

/**
 * 营销网站顶部导航栏组件。
 *
 * 顶部导航栏位置固定，包含品牌 logo、导航菜单（定价、API 文档、GitHub）、
 * 语言和主题切换器，以及登录和注册按钮。在 md 尺寸及以上的屏幕显示完整
 * 导航菜单，小屏幕上导航菜单隐藏。
 *
 * @returns 包含 logo、导航链接和操作按钮的粘性 header 元素。
 */
export function SiteHeader() {
  const t = useTranslations('marketing.nav');

  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="container flex h-14 items-center gap-6">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Kitora
        </Link>
        {/* 在中等屏幕及以上显示主导航菜单 */}
        <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
          <Link href="/pricing" className="transition-colors hover:text-foreground">
            {t('pricing')}
          </Link>
          <Link href="/docs/api" className="transition-colors hover:text-foreground">
            {t('apiDocs')}
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
        {/* 右侧操作区域：语言、主题、登录、注册 */}
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
