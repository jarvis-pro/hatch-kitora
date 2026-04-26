import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { Prisma, SubscriptionStatus } from '@prisma/client';

import { DataPagination } from '@/components/admin/data-pagination';
import { cn } from '@/lib/utils';
import { prisma } from '@/lib/db';

export const metadata: Metadata = {
  title: 'Admin · Subscriptions',
};

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

const STATUSES = [
  'ACTIVE',
  'TRIALING',
  'PAST_DUE',
  'CANCELED',
  'INCOMPLETE',
  'INCOMPLETE_EXPIRED',
  'UNPAID',
] as const satisfies readonly SubscriptionStatus[];

const STATUS_BADGE: Record<SubscriptionStatus, string> = {
  ACTIVE: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  TRIALING: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  PAST_DUE: 'bg-amber-500/15 text-amber-700 dark:text-amber-500',
  CANCELED: 'bg-zinc-500/15 text-zinc-700 dark:text-zinc-400',
  INCOMPLETE: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  INCOMPLETE_EXPIRED: 'bg-red-500/15 text-red-700 dark:text-red-400',
  UNPAID: 'bg-red-500/15 text-red-700 dark:text-red-400',
};

interface PageProps {
  searchParams: Promise<{ status?: string; page?: string }>;
}

function parsePage(raw: string | undefined): number {
  const n = Number(raw ?? '1');
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function parseStatus(raw: string | undefined): SubscriptionStatus | undefined {
  if (!raw) return undefined;
  return (STATUSES as readonly string[]).includes(raw) ? (raw as SubscriptionStatus) : undefined;
}

export default async function AdminSubscriptionsPage({ searchParams }: PageProps) {
  const { status: statusRaw, page: pageRaw } = await searchParams;
  const page = parsePage(pageRaw);
  const status = parseStatus(statusRaw);
  const t = await getTranslations('admin.subscriptions');

  const where: Prisma.SubscriptionWhereInput = status ? { status } : {};

  const [total, items] = await Promise.all([
    prisma.subscription.count({ where }),
    prisma.subscription.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        organization: { select: { id: true, slug: true, name: true } },
      },
    }),
  ]);

  const baseHref = `/admin/subscriptions${status ? `?status=${status}` : ''}`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link
          href="/admin/subscriptions"
          className={cn(
            'rounded-md border px-3 py-1 text-xs',
            !status ? 'bg-foreground text-background' : 'hover:bg-accent',
          )}
        >
          {t('filters.all')}
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/admin/subscriptions?status=${s}`}
            className={cn(
              'rounded-md border px-3 py-1 text-xs',
              status === s ? 'bg-foreground text-background' : 'hover:bg-accent',
            )}
          >
            {t(`status.${s}` as `status.${SubscriptionStatus}`)}
          </Link>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">{t('table.organization')}</th>
              <th className="px-4 py-3 font-medium">{t('table.status')}</th>
              <th className="px-4 py-3 font-medium">{t('table.priceId')}</th>
              <th className="px-4 py-3 font-medium">{t('table.periodEnd')}</th>
              <th className="px-4 py-3 font-medium">{t('table.createdAt')}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  {t('empty')}
                </td>
              </tr>
            ) : (
              items.map((sub) => (
                <tr key={sub.id} className="border-t">
                  <td className="px-4 py-3">
                    <div className="font-medium">{sub.organization.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {sub.organization.slug}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'rounded-md px-2 py-0.5 text-xs font-medium',
                        STATUS_BADGE[sub.status],
                      )}
                    >
                      {t(`status.${sub.status}` as `status.${SubscriptionStatus}`)}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {sub.stripePriceId}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {sub.currentPeriodEnd.toISOString().slice(0, 10)}
                    {sub.cancelAtPeriodEnd ? (
                      <span className="ml-2 text-xs text-amber-600">{t('cancelAtEnd')}</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {sub.createdAt.toISOString().slice(0, 10)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <DataPagination baseHref={baseHref} page={page} pageSize={PAGE_SIZE} total={total} />
    </div>
  );
}
