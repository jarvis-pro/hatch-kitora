import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/routing';

// 所有可用的价格计划
const plans = [
  { id: 'free', priceId: null },
  { id: 'pro', priceId: process.env.STRIPE_PRO_PRICE_ID ?? 'price_pro' },
  { id: 'team', priceId: process.env.STRIPE_TEAM_PRICE_ID ?? 'price_team' },
] as const;

/**
 * 定价页面。
 *
 * 展示三种价格计划（免费、专业、团队），支持升级和购买操作。
 * Client 端渲染，采用 i18n 国际化。
 *
 * @returns 定价页面 JSX
 */
export default function PricingPage() {
  const t = useTranslations('marketing.pricing');

  return (
    <section className="container py-24">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-4xl font-bold tracking-tight">{t('title')}</h1>
        <p className="mt-4 text-lg text-muted-foreground">{t('subtitle')}</p>
      </div>

      <div className="mx-auto mt-16 grid max-w-5xl gap-6 md:grid-cols-3">
        {plans.map((plan) => (
          <div key={plan.id} className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="text-xl font-semibold">{t(`plans.${plan.id}.name`)}</h2>
            <p className="mt-2 text-3xl font-bold">{t(`plans.${plan.id}.price`)}</p>
            <p className="mt-2 text-sm text-muted-foreground">{t(`plans.${plan.id}.tagline`)}</p>
            <ul className="mt-6 space-y-2 text-sm">
              {(t.raw(`plans.${plan.id}.features`) as string[]).map((feature) => (
                <li key={feature} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 text-primary" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            <Button
              asChild
              className="mt-6 w-full"
              variant={plan.id === 'pro' ? 'default' : 'outline'}
            >
              <Link href={plan.id === 'free' ? '/signup' : `/checkout?plan=${plan.id}`}>
                {t(`plans.${plan.id}.cta`)}
              </Link>
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
