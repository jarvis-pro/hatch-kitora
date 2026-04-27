import { ArrowRight, Globe2, ShieldCheck, Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link } from '@/i18n/routing';
import { Button } from '@/components/ui/button';

/**
 * 营销首页。
 *
 * 展示产品特色、行动号召和功能介绍。
 * Client 端渲染，采用 i18n 国际化。
 *
 * @returns 营销首页 JSX
 */
export default function HomePage() {
  const t = useTranslations('marketing.home');

  return (
    <>
      <section className="container flex flex-col items-center gap-8 py-24 text-center md:py-32">
        <div className="rounded-full border bg-muted/40 px-4 py-1.5 text-sm text-muted-foreground">
          {t('eyebrow')}
        </div>
        <h1 className="max-w-3xl text-balance text-4xl font-bold tracking-tight md:text-6xl">
          {t('title')}
        </h1>
        <p className="max-w-2xl text-balance text-lg text-muted-foreground">{t('subtitle')}</p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg">
            <Link href="/signup">
              {t('cta.primary')}
              <ArrowRight className="ml-2 size-4" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/pricing">{t('cta.secondary')}</Link>
          </Button>
        </div>
      </section>

      <section className="container grid gap-6 pb-24 md:grid-cols-3">
        <FeatureCard
          icon={<Zap className="size-5" />}
          title={t('features.fast.title')}
          desc={t('features.fast.desc')}
        />
        <FeatureCard
          icon={<Globe2 className="size-5" />}
          title={t('features.global.title')}
          desc={t('features.global.desc')}
        />
        <FeatureCard
          icon={<ShieldCheck className="size-5" />}
          title={t('features.secure.title')}
          desc={t('features.secure.desc')}
        />
      </section>
    </>
  );
}

/**
 * 功能特色卡片组件。
 *
 * 显示图标、标题和描述的统一卡片样式。
 *
 * @param icon 功能图标元素
 * @param title 功能标题
 * @param desc 功能描述
 * @returns 功能卡片 JSX
 */
function FeatureCard({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      {/* 功能图标容器 */}
      <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </div>
      {/* 功能标题 */}
      <h3 className="mb-2 text-lg font-semibold">{title}</h3>
      {/* 功能描述 */}
      <p className="text-sm text-muted-foreground">{desc}</p>
    </div>
  );
}
