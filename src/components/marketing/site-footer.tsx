import { useTranslations } from 'next-intl';

import { env } from '@/env';
import { Link } from '@/i18n/routing';
import { isCnRegion } from '@/lib/region';

export function SiteFooter() {
  const t = useTranslations('marketing.footer');
  const year = new Date().getFullYear();

  // CN deployments must surface ICP / 公安部备案 numbers in the footer.
  const showIcp = isCnRegion() && env.ICP_NUMBER;

  return (
    <footer className="border-t">
      <div className="container flex flex-col items-center justify-between gap-2 py-6 text-sm text-muted-foreground md:flex-row">
        <p>
          © {year} Kitora. {t('rights')}
        </p>
        <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          {showIcp ? (
            <>
              <Link href="/icp" className="hover:text-foreground hover:underline">
                {env.ICP_NUMBER}
              </Link>
              {env.PUBLIC_SECURITY_NUMBER ? (
                <a
                  href="https://beian.mps.gov.cn/"
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-foreground hover:underline"
                >
                  {env.PUBLIC_SECURITY_NUMBER}
                </a>
              ) : null}
            </>
          ) : null}
          <span>{t('built')}</span>
        </p>
      </div>
    </footer>
  );
}
