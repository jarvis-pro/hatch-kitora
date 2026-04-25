import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import type { Prisma } from '@prisma/client';

import { DataPagination } from '@/components/admin/data-pagination';
import { RoleSelect } from '@/components/admin/role-select';
import { SearchForm } from '@/components/admin/search-form';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export const metadata: Metadata = {
  title: 'Admin · Users',
};

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{ q?: string; page?: string }>;
}

function parsePage(raw: string | undefined): number {
  const n = Number(raw ?? '1');
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export default async function AdminUsersPage({ searchParams }: PageProps) {
  const { q = '', page: pageRaw } = await searchParams;
  const page = parsePage(pageRaw);
  const t = await getTranslations('admin.users');

  const session = await auth();
  const meId = session?.user?.id;

  const where: Prisma.UserWhereInput = q
    ? {
        OR: [
          { email: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ],
      }
    : {};

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        emailVerified: true,
        createdAt: true,
      },
    }),
  ]);

  const baseHref = `/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <SearchForm
          action="/admin/users"
          defaultValue={q}
          placeholder={t('searchPlaceholder')}
          submitLabel={t('search')}
        />
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">{t('table.email')}</th>
              <th className="px-4 py-3 font-medium">{t('table.name')}</th>
              <th className="px-4 py-3 font-medium">{t('table.verified')}</th>
              <th className="px-4 py-3 font-medium">{t('table.createdAt')}</th>
              <th className="px-4 py-3 font-medium">{t('table.role')}</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  {t('empty')}
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <tr key={user.id} className="border-t">
                  <td className="px-4 py-3 font-medium">{user.email}</td>
                  <td className="px-4 py-3 text-muted-foreground">{user.name ?? '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {user.emailVerified ? t('verified.yes') : t('verified.no')}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {user.createdAt.toISOString().slice(0, 10)}
                  </td>
                  <td className="px-4 py-3">
                    <RoleSelect
                      userId={user.id}
                      currentRole={user.role}
                      disabled={user.id === meId}
                    />
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
