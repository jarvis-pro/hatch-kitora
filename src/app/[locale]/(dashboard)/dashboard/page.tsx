import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { SubscriptionStatusBadge } from '@/components/billing/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/routing';
import { auth } from '@/lib/auth';
import { getCurrentBilling } from '@/lib/billing/current';
import { prisma } from '@/lib/db';

export const metadata: Metadata = {
  title: 'Dashboard',
};

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ checkout?: string }>;
}

function daysSince(date: Date): number {
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000)));
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');

  const [{ checkout }, t, user, billing] = await Promise.all([
    searchParams,
    getTranslations('dashboard.home'),
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { name: true, emailVerified: true, createdAt: true },
    }),
    getCurrentBilling(session.user.id),
  ]);

  if (!user) redirect('/login');

  const checkoutSuccess = checkout === 'success';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('greeting', { name: user.name ?? t('friend') })}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {checkoutSuccess ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-400">
          {t('checkoutSuccess')}
        </div>
      ) : null}

      {!user.emailVerified ? (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-400">
          <span>{t('verifyEmailNotice')}</span>
          <Button asChild variant="outline" size="sm">
            <Link href="/verify-email">{t('verifyEmailCta')}</Link>
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('stats.plan')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <p className="text-3xl font-semibold tracking-tight">{billing.plan.name}</p>
              {billing.subscription ? (
                <SubscriptionStatusBadge status={billing.subscription.status} />
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {billing.subscription
                ? t('stats.planHint', {
                    date: formatDate(billing.subscription.currentPeriodEnd),
                  })
                : t('stats.planFree')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('stats.account')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tracking-tight">
              {user.emailVerified ? t('stats.accountVerified') : t('stats.accountPending')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('stats.memberFor', { days: daysSince(user.createdAt) })}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('stats.nextSteps')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button asChild variant="outline" className="w-full justify-start">
              <Link href="/dashboard/billing">{t('quickLinks.billing')}</Link>
            </Button>
            <Button asChild variant="outline" className="w-full justify-start">
              <Link href="/settings">{t('quickLinks.settings')}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
