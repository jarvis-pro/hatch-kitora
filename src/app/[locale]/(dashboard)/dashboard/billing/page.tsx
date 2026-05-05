import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { ManageSubscriptionButton } from './_components/manage-subscription-button';
import { SubscriptionStatusBadge } from '../_components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/routing';
import { requireActiveOrg } from '@/lib/auth/session';
import { getCurrentBilling } from '@/services/billing/current';

/**
 * 计费页的元数据。
 */
export const metadata: Metadata = {
  title: 'Billing',
};

// 禁用缓存，每次请求都重新获取最新订阅数据
export const dynamic = 'force-dynamic';

/**
 * 将美分金额格式化为 USD 货币字符串。
 *
 * @param cents 金额，单位为美分
 * @returns 格式化的 USD 字符串，如 "$12.34"
 */
function formatUsd(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

/**
 * 将 Date 对象格式化为 ISO 日期字符串。
 *
 * @param d Date 实例
 * @returns ISO 格式的日期字符串，如 "2026-04-27"
 */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 计费管理页面。
 *
 * 显示当前订阅计划、状态和发票信息。需要登录且为活跃组织成员。
 * Server 端渲染，采用 i18n 国际化。
 *
 * @returns 计费页面 JSX
 */
export default async function BillingPage() {
  // 验证用户登录且为活跃组织成员，否则重定向到登录页
  const me = await requireActiveOrg().catch(() => null);
  if (!me) redirect('/login');

  const t = await getTranslations('billing');
  const { plan, subscription } = await getCurrentBilling(me.orgId);

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
