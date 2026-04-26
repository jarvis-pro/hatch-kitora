import type { BackgroundJobStatus, Prisma } from '@prisma/client';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { DataPagination } from '@/components/admin/data-pagination';
import { JobRowActions } from '@/components/admin/jobs/job-row-actions';
import { prisma } from '@/lib/db';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Admin · Background jobs',
};

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

const ALL_STATUSES: ReadonlyArray<BackgroundJobStatus> = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'DEAD_LETTER',
  'CANCELED',
];

type Tab = 'overview' | 'recent' | 'dlq';
const ALL_TABS: ReadonlyArray<Tab> = ['overview', 'recent', 'dlq'];

interface PageProps {
  searchParams: Promise<{
    tab?: string;
    type?: string;
    status?: string;
    page?: string;
  }>;
}

function parsePage(raw: string | undefined): number {
  const n = Number(raw ?? '1');
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function parseTab(raw: string | undefined): Tab {
  return (ALL_TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'overview';
}

function parseStatus(raw: string | undefined): BackgroundJobStatus | undefined {
  if (!raw) return undefined;
  return (ALL_STATUSES as readonly string[]).includes(raw)
    ? (raw as BackgroundJobStatus)
    : undefined;
}

/**
 * RFC 0008 §4.8 — Background jobs admin 视图。
 *
 * 三 Tab：
 *
 *   - **overview** — 按 type 聚合的近 24h 行级统计：成功率 / 失败数 / DLQ 数。
 *     给运维「平台健康度」的瞬时快照。
 *   - **recent** — 最近 100 行的明细（不限 status），按 type / status 过滤。
 *     大多数日常排查从这里入手。
 *   - **dlq** — 仅 DEAD_LETTER，PR-4 后续 commit 会在每行加 retry / cancel
 *     按钮（admin 手动救援，对应 `job.cancelled` / `job.retried` 审计动作）。
 *
 * 不暴露给非 admin —— 双层防护：middleware 拦 /admin/* + AdminLayout 重新检查
 * `session.user.role === 'ADMIN'`。
 */
export default async function AdminJobsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const tab = parseTab(sp.tab);
  const t = await getTranslations('admin.jobs');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <div className="flex gap-2 border-b">
        {ALL_TABS.map((tabKey) => (
          <Link
            key={tabKey}
            href={`/admin/jobs?tab=${tabKey}`}
            className={cn(
              '-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm transition-colors',
              tab === tabKey
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`tabs.${tabKey}` as 'tabs.overview')}
          </Link>
        ))}
      </div>

      {tab === 'overview' ? (
        <OverviewTab />
      ) : tab === 'recent' ? (
        <RecentTab type={sp.type} status={parseStatus(sp.status)} page={parsePage(sp.page)} />
      ) : (
        <DlqTab page={parsePage(sp.page)} />
      )}
    </div>
  );
}

async function OverviewTab() {
  const t = await getTranslations('admin.jobs');
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // 按 (type, status) 聚合 —— 单一 groupBy round-trip。
  const [groups, totalCount, dlqCount, oldestPending] = await Promise.all([
    prisma.backgroundJob.groupBy({
      by: ['type', 'status'],
      where: { createdAt: { gte: since24h } },
      _count: true,
    }),
    prisma.backgroundJob.count(),
    prisma.backgroundJob.count({ where: { status: 'DEAD_LETTER' } }),
    prisma.backgroundJob.findFirst({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);

  // pivot type → { status: count, ... }。
  type Row = { type: string; counts: Partial<Record<BackgroundJobStatus, number>> };
  const byType = new Map<string, Row>();
  for (const g of groups) {
    const r = byType.get(g.type) ?? { type: g.type, counts: {} };
    r.counts[g.status] = g._count;
    byType.set(g.type, r);
  }
  const rows = Array.from(byType.values()).sort((a, b) => a.type.localeCompare(b.type));

  const lagSeconds = oldestPending
    ? Math.floor((Date.now() - oldestPending.createdAt.getTime()) / 1000)
    : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label={t('overview.totalRows')} value={String(totalCount)} />
        <StatCard
          label={t('overview.dlqRows')}
          value={String(dlqCount)}
          tone={dlqCount > 0 ? 'warn' : 'ok'}
        />
        <StatCard
          label={t('overview.queueLag')}
          value={lagSeconds > 0 ? `${lagSeconds}s` : '—'}
          tone={lagSeconds > 120 ? 'warn' : 'ok'}
        />
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">{t('overview.type')}</th>
              {ALL_STATUSES.map((s) => (
                <th key={s} className="px-4 py-3 font-medium">
                  {t(`status.${s}` as 'status.PENDING')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={ALL_STATUSES.length + 1}
                  className="px-4 py-10 text-center text-muted-foreground"
                >
                  {t('overview.empty')}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.type} className="border-t">
                  <td className="px-4 py-3 font-mono text-xs">{r.type}</td>
                  {ALL_STATUSES.map((s) => (
                    <td key={s} className="px-4 py-3 font-mono text-xs">
                      {r.counts[s] ?? 0}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
        <p className="border-t bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
          {t('overview.windowHint')}
        </p>
      </div>
    </div>
  );
}

interface RecentTabProps {
  type: string | undefined;
  status: BackgroundJobStatus | undefined;
  page: number;
}

async function RecentTab({ type, status, page }: RecentTabProps) {
  const t = await getTranslations('admin.jobs');
  const where: Prisma.BackgroundJobWhereInput = {
    ...(type ? { type } : {}),
    ...(status ? { status } : {}),
  };

  const [total, items, distinctTypes] = await Promise.all([
    prisma.backgroundJob.count({ where }),
    prisma.backgroundJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        type: true,
        status: true,
        attempt: true,
        maxAttempts: true,
        runId: true,
        priority: true,
        queue: true,
        nextAttemptAt: true,
        createdAt: true,
        completedAt: true,
        lastError: true,
      },
    }),
    prisma.backgroundJob.findMany({
      distinct: ['type'],
      select: { type: true },
      orderBy: { type: 'asc' },
    }),
  ]);

  const baseHref = (() => {
    const params = new URLSearchParams({ tab: 'recent' });
    if (type) params.set('type', type);
    if (status) params.set('status', status);
    return `/admin/jobs?${params.toString()}`;
  })();

  return (
    <div className="space-y-4">
      <FilterRow
        currentType={type}
        currentStatus={status}
        types={distinctTypes.map((d) => d.type)}
      />
      <JobsTable items={items} t={await getTranslations('admin.jobs')} />
      <DataPagination baseHref={baseHref} page={page} pageSize={PAGE_SIZE} total={total} />
      <p className="text-xs text-muted-foreground">{t('recent.totalHint', { total })}</p>
    </div>
  );
}

async function DlqTab({ page }: { page: number }) {
  const t = await getTranslations('admin.jobs');
  const where: Prisma.BackgroundJobWhereInput = { status: 'DEAD_LETTER' };

  const [total, items] = await Promise.all([
    prisma.backgroundJob.count({ where }),
    prisma.backgroundJob.findMany({
      where,
      orderBy: { completedAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        type: true,
        status: true,
        attempt: true,
        maxAttempts: true,
        runId: true,
        priority: true,
        queue: true,
        nextAttemptAt: true,
        createdAt: true,
        completedAt: true,
        lastError: true,
      },
    }),
  ]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('dlq.intro')}</p>
      <JobsTable items={items} t={await getTranslations('admin.jobs')} withActions />
      <DataPagination
        baseHref="/admin/jobs?tab=dlq"
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// shared sub-components
// ─────────────────────────────────────────────────────────────────────

interface FilterRowProps {
  currentType: string | undefined;
  currentStatus: BackgroundJobStatus | undefined;
  types: string[];
}

function FilterRow({ currentType, currentStatus, types }: FilterRowProps) {
  function chip(href: string, label: string, active: boolean): React.ReactNode {
    return (
      <Link
        href={href}
        className={cn(
          'rounded-md border px-3 py-1 text-xs',
          active ? 'bg-foreground text-background' : 'hover:bg-accent',
        )}
      >
        {label}
      </Link>
    );
  }

  function statusHref(s: BackgroundJobStatus | undefined): string {
    const params = new URLSearchParams({ tab: 'recent' });
    if (currentType) params.set('type', currentType);
    if (s) params.set('status', s);
    return `/admin/jobs?${params.toString()}`;
  }

  function typeHref(typ: string | undefined): string {
    const params = new URLSearchParams({ tab: 'recent' });
    if (typ) params.set('type', typ);
    if (currentStatus) params.set('status', currentStatus);
    return `/admin/jobs?${params.toString()}`;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {chip(typeHref(undefined), 'all types', currentType === undefined)}
        {types.map((typ) => chip(typeHref(typ), typ, currentType === typ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {chip(statusHref(undefined), 'any status', currentStatus === undefined)}
        {ALL_STATUSES.map((s) => chip(statusHref(s), s, currentStatus === s))}
      </div>
    </div>
  );
}

interface JobsTableProps {
  items: ReadonlyArray<{
    id: string;
    type: string;
    status: BackgroundJobStatus;
    attempt: number;
    maxAttempts: number;
    runId: string | null;
    priority: number;
    queue: string;
    nextAttemptAt: Date;
    createdAt: Date;
    completedAt: Date | null;
    lastError: string | null;
  }>;
  // next-intl 的 getTranslations 返回 typed callable；这里仅用 .raw key。
  t: Awaited<ReturnType<typeof getTranslations<'admin.jobs'>>>;
  /** DLQ Tab 传 true 渲染 retry / cancel 列；其它 Tab 不渲染避免误操作。 */
  withActions?: boolean;
}

function JobsTable({ items, t, withActions = false }: JobsTableProps) {
  const colSpan = withActions ? 7 : 6;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">{t('table.createdAt')}</th>
            <th className="px-4 py-3 font-medium">{t('table.type')}</th>
            <th className="px-4 py-3 font-medium">{t('table.status')}</th>
            <th className="px-4 py-3 font-medium">{t('table.attempt')}</th>
            <th className="px-4 py-3 font-medium">{t('table.runId')}</th>
            <th className="px-4 py-3 font-medium">{t('table.lastError')}</th>
            {withActions ? (
              <th className="px-4 py-3 font-medium">{t('table.actionsHeader')}</th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={colSpan} className="px-4 py-10 text-center text-muted-foreground">
                {t('table.empty')}
              </td>
            </tr>
          ) : (
            items.map((row) => (
              <tr key={row.id} className="border-t align-top">
                <td className="px-4 py-3 font-mono text-xs">
                  {row.createdAt.toISOString().replace('T', ' ').slice(0, 19)}
                </td>
                <td className="px-4 py-3 font-mono text-xs">{row.type}</td>
                <td className="px-4 py-3">
                  <StatusPill status={row.status} />
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  {row.attempt}/{row.maxAttempts}
                </td>
                <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
                  {row.runId ?? '—'}
                </td>
                <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
                  {row.lastError ? (
                    <code className="block max-w-md whitespace-pre-wrap break-all">
                      {row.lastError.slice(0, 200)}
                      {row.lastError.length > 200 ? '…' : ''}
                    </code>
                  ) : (
                    '—'
                  )}
                </td>
                {withActions ? (
                  <td className="px-4 py-3">
                    <JobRowActions jobId={row.id} />
                  </td>
                ) : null}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: BackgroundJobStatus }) {
  const tone =
    status === 'SUCCEEDED'
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
      : status === 'DEAD_LETTER' || status === 'FAILED'
        ? 'bg-rose-500/15 text-rose-700 dark:text-rose-400'
        : status === 'RUNNING'
          ? 'bg-sky-500/15 text-sky-700 dark:text-sky-400'
          : status === 'CANCELED'
            ? 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400'
            : 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
  return <span className={cn('rounded-md px-2 py-0.5 font-mono text-[11px]', tone)}>{status}</span>;
}

function StatCard({
  label,
  value,
  tone = 'ok',
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn';
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-4',
        tone === 'warn' ? 'border-amber-500/40 bg-amber-500/5' : 'bg-muted/20',
      )}
    >
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}
