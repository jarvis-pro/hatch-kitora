import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { Prisma } from '@prisma/client';

import { DataPagination } from '@/components/admin/data-pagination';
import { prisma } from '@/lib/db';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Admin · API Tokens',
};

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 30;

type StatusFilter = 'active' | 'revoked' | 'expired';

interface PageProps {
  searchParams: Promise<{ status?: string; page?: string }>;
}

function parsePage(raw: string | undefined): number {
  const n = Number(raw ?? '1');
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function parseStatus(raw: string | undefined): StatusFilter | undefined {
  if (raw === 'active' || raw === 'revoked' || raw === 'expired') return raw;
  return undefined;
}

export default async function AdminApiTokensPage({ searchParams }: PageProps) {
  const { status: statusRaw, page: pageRaw } = await searchParams;
  const page = parsePage(pageRaw);
  const status = parseStatus(statusRaw);
  const t = await getTranslations('admin.apiTokens');

  const now = new Date();
  let where: Prisma.ApiTokenWhereInput = {};
  if (status === 'active') {
    where = { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  } else if (status === 'revoked') {
    where = { revokedAt: { not: null } };
  } else if (status === 'expired') {
    where = { revokedAt: null, expiresAt: { lte: now } };
  }

  const [total, items] = await Promise.all([
    prisma.apiToken.count({ where }),
    prisma.apiToken.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        user: { select: { id: true, email: true } },
        organization: { select: { slug: true, name: true } },
      },
    }),
  ]);

  const baseHref = `/admin/api-tokens${status ? `?status=${status}` : ''}`;

  function tabHref(s?: StatusFilter): string {
    return `/admin/api-tokens${s ? `?status=${s}` : ''}`;
  }

  function classifyStatus(row: (typeof items)[number]): StatusFilter {
    if (row.revokedAt) return 'revoked';
    if (row.expiresAt && row.expiresAt.getTime() < now.getTime()) return 'expired';
    return 'active';
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {(
          [undefined, 'active', 'revoked', 'expired'] as const satisfies readonly (
            | StatusFilter
            | undefined
          )[]
        ).map((s) => (
          <Link
            key={s ?? 'all'}
            href={tabHref(s)}
            className={cn(
              'rounded-md border px-3 py-1 text-xs',
              status === s ? 'bg-foreground text-background' : 'hover:bg-accent',
            )}
          >
            {s ? t(`filters.${s}`) : t('filters.all')}
          </Link>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">{t('table.organization')}</th>
              <th className="px-4 py-3 font-medium">{t('table.user')}</th>
              <th className="px-4 py-3 font-medium">{t('table.name')}</th>
              <th className="px-4 py-3 font-medium">{t('table.prefix')}</th>
              <th className="px-4 py-3 font-medium">{t('table.status')}</th>
              <th className="px-4 py-3 font-medium">{t('table.lastUsed')}</th>
              <th className="px-4 py-3 font-medium">{t('table.created')}</th>
              <th className="px-4 py-3 font-medium">{t('table.expires')}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                  {t('empty')}
                </td>
              </tr>
            ) : (
              items.map((row) => {
                const cls = classifyStatus(row);
                return (
                  <tr key={row.id} className="border-t align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium">{row.organization.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {row.organization.slug}
                      </div>
                    </td>
                    <td className="px-4 py-3">{row.user.email}</td>
                    <td className="px-4 py-3">{row.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {row.prefix}…
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'rounded-md px-2 py-0.5 text-xs font-medium',
                          cls === 'active' &&
                            'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
                          cls === 'revoked' && 'bg-zinc-500/15 text-zinc-700 dark:text-zinc-400',
                          cls === 'expired' && 'bg-amber-500/15 text-amber-700 dark:text-amber-500',
                        )}
                      >
                        {t(`statusValue.${cls}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {row.lastUsedAt?.toISOString().slice(0, 10) ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {row.createdAt.toISOString().slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {row.expiresAt?.toISOString().slice(0, 10) ?? '—'}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <DataPagination baseHref={baseHref} page={page} pageSize={PAGE_SIZE} total={total} />
    </div>
  );
}
