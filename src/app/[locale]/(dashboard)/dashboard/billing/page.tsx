import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { ManageSubscriptionButton } from '@/components/billing/manage-subscription-button';
import { SubscriptionStatusBadge } from '@/components/billing/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/routing';
import { auth } from '@/lib/auth';
import { getCurrentBilling } from '@/lib/billing/current';

export const metadata: Metadata = {
  title: 'Billing',
};

export const dynamic = 'force-dynamic';

function formatUsd(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function BillingPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');

  const t = await getTranslations('billing');
  const { plan, subscription } = await getCurrentBilling(session.user.id);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <span>{t('currentPlan')}</span>
            <span className="rounded-md border px-2 py-0.5 text-xs">{plan.name}</span>
          </CardTitle>
          <CardDescription>
            {plan.amountCents > 0 && plan.interval
              ? t('priceLine', {
                  price: formatUsd(plan.amountCents),
                  interval: t(`interval.${plan.interval}`),
                })
              : t('priceFree')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {subscription ? (
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t('fields.status')}</dt>
                <dd className="mt-1">
                  <SubscriptionStatusBadge status={subscription.status} />
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t('fields.periodEnd')}</dt>
                <dd className="mt-1 text-sm">{formatDate(subscription.currentPeriodEnd)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t('fields.renewal')}</dt>
                <dd className="mt-1 text-sm">
                  {subscription.cancelAtPeriodEnd ? t('willCancel') : t('willRenew')}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">{t('freeBlurb')}</p>
          )}

          <div className="flex flex-wrap gap-3 pt-2">
            {subscription ? (
              <ManageSubscriptionButton />
            ) : (
              <Button asChild>
                <Link href="/pricing">{t('upgrade')}</Link>
              </Button>
            )}
            <Button asChild variant="outline">
              <Link href="/pricing">{t('viewPlans')}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('invoices.title')}</CardTitle>
          <CardDescription>{t('invoices.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {subscription ? (
            <ManageSubscriptionButton variant="outline" />
          ) : (
            <p className="text-sm text-muted-foreground">{t('invoices.empty')}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
