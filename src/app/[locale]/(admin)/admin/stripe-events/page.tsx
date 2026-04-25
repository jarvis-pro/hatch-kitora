import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { DataPagination } from '@/components/admin/data-pagination';
import { prisma } from '@/lib/db';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Admin · Stripe events',
};

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<{ type?: string; page?: string }>;
}

function parsePage(raw: string | undefined): number {
  const n = Number(raw ?? '1');
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export default async function AdminStripeEventsPage({ searchParams }: PageProps) {
  const { type, page: pageRaw } = await searchParams;
  const page = parsePage(pageRaw);
  const t = await getTranslations('admin.stripeEvents');

  const where = type ? { type } : {};

  // Bring back the most-used types so users can filter without typing.
  const [total, items, distinctTypes] = await Promise.all([
    prisma.stripeEvent.count({ where }),
    prisma.stripeEvent.findMany({
      where,
      orderBy: { processedAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.stripeEvent.groupBy({
      by: ['type'],
      _count: { _all: true },
      orderBy: { _count: { type: 'desc' } },
      take: 10,
    }),
  ]);

  const baseHref = `/admin/stripe-events${type ? `?type=${encodeURIComponent(type)}` : ''}`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {distinctTypes.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <Link
            href="/admin/stripe-events"
            className={cn(
              'rounded-md border px-3 py-1 text-xs',
              !type ? 'bg-foreground text-background' : 'hover:bg-accent',
            )}
          >
            {t('filters.all')}
          </Link>
          {distinctTypes.map((row) => (
            <Link
              key={row.type}
              href={`/admin/stripe-events?type=${encodeURIComponent(row.type)}`}
              className={cn(
                'rounded-md border px-3 py-1 font-mono text-xs',
                type === row.type ? 'bg-foreground text-background' : 'hover:bg-accent',
              )}
            >
              {row.type}{' '}
              <span className="text-muted-foreground">({row._count._all.toLocaleString()})</span>
            </Link>
          ))}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">{t('table.processedAt')}</th>
              <th className="px-4 py-3 font-medium">{t('table.id')}</th>
              <th className="px-4 py-3 font-medium">{t('table.type')}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-10 text-center text-muted-foreground">
                  {t('empty')}
                </td>
              </tr>
            ) : (
              items.map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="px-4 py-3 font-mono text-xs">
                    {row.processedAt.toISOString().replace('T', ' ').slice(0, 19)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{row.id}</td>
                  <td className="px-4 py-3 font-mono text-xs">{row.type}</td>
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
