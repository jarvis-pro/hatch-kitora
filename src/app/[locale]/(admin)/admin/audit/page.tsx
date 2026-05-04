import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { DataPagination } from '@/components/admin/data-pagination';
import { SearchForm } from '@/components/admin/search-form';
import { AUDIT_ACTIONS, auditActionToI18nKey, type AuditAction } from '@/services/audit';
import { prisma } from '@/lib/db';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Admin · Audit log',
};

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 30;

interface PageProps {
  searchParams: Promise<{ q?: string; action?: string; page?: string }>;
}

function parsePage(raw: string | undefined): number {
  const n = Number(raw ?? '1');
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function parseAction(raw: string | undefined): AuditAction | undefined {
  if (!raw) return undefined;
  return (AUDIT_ACTIONS as readonly string[]).includes(raw) ? (raw as AuditAction) : undefined;
}

export default async function AdminAuditPage({ searchParams }: PageProps) {
  const { q = '', action: actionRaw, page: pageRaw } = await searchParams;
  const page = parsePage(pageRaw);
  const action = parseAction(actionRaw);
  const t = await getTranslations('admin.audit');

  // 在查询日志前解析电子邮件搜索的 actor ID——保持日志查询简单
  //（不需要连接）并在没有用户匹配搜索词时让我们短路。
  let actorIds: string[] | undefined;
  if (q) {
    const matches = await prisma.user.findMany({
      where: { email: { contains: q, mode: 'insensitive' } },
      select: { id: true },
      take: 200,
    });
    actorIds = matches.map((m) => m.id);
    if (actorIds.length === 0) actorIds = ['__no_match__'];
  }

  const where = {
    ...(action ? { action } : {}),
    ...(actorIds ? { actorId: { in: actorIds } } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  // 批量解析 actor 电子邮件（单一往返）。
  const ids = Array.from(new Set(items.map((i) => i.actorId).filter((x): x is string => !!x)));
  const actors = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } })
    : [];
  const actorEmail = new Map(actors.map((a) => [a.id, a.email]));

  const baseHref = (() => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (action) params.set('action', action);
    const qs = params.toString();
    return `/admin/audit${qs ? `?${qs}` : ''}`;
  })();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <SearchForm
          action="/admin/audit"
          defaultValue={q}
          placeholder={t('searchPlaceholder')}
          submitLabel={t('search')}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Link
          href={`/admin/audit${q ? `?q=${encodeURIComponent(q)}` : ''}`}
          className={cn(
            'rounded-md border px-3 py-1 text-xs',
            !action ? 'bg-foreground text-background' : 'hover:bg-accent',
          )}
        >
          {t('filters.all')}
        </Link>
        {AUDIT_ACTIONS.map((a) => {
          const params = new URLSearchParams();
          if (q) params.set('q', q);
          params.set('action', a);
          return (
            <Link
              key={a}
              href={`/admin/audit?${params.toString()}`}
              className={cn(
                'rounded-md border px-3 py-1 text-xs',
                action === a ? 'bg-foreground text-background' : 'hover:bg-accent',
              )}
            >
              {t(`actions.${auditActionToI18nKey(a)}` as 'actions.role_set')}
            </Link>
          );
        })}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">{t('table.time')}</th>
              <th className="px-4 py-3 font-medium">{t('table.actor')}</th>
              <th className="px-4 py-3 font-medium">{t('table.action')}</th>
              <th className="px-4 py-3 font-medium">{t('table.target')}</th>
              <th className="px-4 py-3 font-medium">{t('table.metadata')}</th>
              <th className="px-4 py-3 font-medium">{t('table.ip')}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  {t('empty')}
                </td>
              </tr>
            ) : (
              items.map((row) => {
                const isKnownAction = (AUDIT_ACTIONS as readonly string[]).includes(row.action);
                return (
                  <tr key={row.id} className="border-t align-top">
                    <td className="px-4 py-3 font-mono text-xs">
                      {row.createdAt.toISOString().replace('T', ' ').slice(0, 19)}
                    </td>
                    <td className="px-4 py-3">
                      {row.actorId ? (
                        <span>{actorEmail.get(row.actorId) ?? row.actorId}</span>
                      ) : (
                        <span className="text-muted-foreground">{t('system')}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs">
                        {isKnownAction
                          ? t(`actions.${auditActionToI18nKey(row.action)}` as 'actions.role_set')
                          : row.action}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {row.target ?? '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
                      {row.metadata ? (
                        <code className="whitespace-pre-wrap break-all">
                          {JSON.stringify(row.metadata)}
                        </code>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {row.ip ?? '—'}
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
