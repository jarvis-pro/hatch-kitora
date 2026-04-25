import { ArrowRight, Globe2, ShieldCheck, Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link } from '@/i18n/routing';
import { Button } from '@/components/ui/button';

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
        <FeatureCard icon={<Zap className="size-5" />} title={t('features.fast.title')} desc={t('features.fast.desc')} />
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
      <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </div>
      <h3 className="mb-2 text-lg font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{desc}</p>
    </div>
  );
}
