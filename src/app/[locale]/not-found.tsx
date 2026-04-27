import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/routing';

/**
 * 404 未找到页面。
 *
 * 当用户访问不存在的路由时显示。
 * Client 端渲染，采用 i18n 国际化。
 *
 * @returns 404 页面 JSX
 */
export default function NotFound() {
  const t = useTranslations('errors.notFound');

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
      <p className="max-w-md text-muted-foreground">{t('description')}</p>
      <Button asChild>
        <Link href="/">{t('cta')}</Link>
      </Button>
    </div>
  );
}
