import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import type { Prisma } from '@prisma/client';

import { DataPagination } from '@/components/admin/data-pagination';
import { Reset2faButton } from '@/components/admin/reset-2fa-button';
import { RoleSelect } from '@/components/admin/role-select';
import { SearchForm } from '@/components/admin/search-form';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';

/**
 * 用户管理页的元数据。
 */
export const metadata: Metadata = {
  title: 'Admin · Users',
};

// 禁用缓存，每次请求都重新获取最新数据
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{ q?: string; page?: string }>;
}

/**
 * 从查询字符串中解析并验证页码。
 *
 * @param raw 原始页码参数
 * @returns 有效的页码（最小值为 1）
 */
function parsePage(raw: string | undefined): number {
  const n = Number(raw ?? '1');
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * 用户管理页面 - 列表展示与搜索。
 *
 * 支持按邮箱或姓名搜索用户，可修改用户角色及重置 2FA。
 * Server 端渲染，需要管理员权限。采用 i18n 国际化。
 *
 * @param searchParams 查询参数，包含搜索关键词 q 和 page
 * @returns 用户管理页面 JSX
 */
export default async function AdminUsersPage({ searchParams }: PageProps) {
  const { q = '', page: pageRaw } = await searchParams;
  const page = parsePage(pageRaw);
  const t = await getTranslations('admin.users');

  // 获取当前登录用户的 ID，用于禁用自己的角色编辑
  const session = await auth();
  const meId = session?.user?.id;

  // 构建搜索条件：邮箱或姓名模糊匹配
  const where: Prisma.UserWhereInput = q
    ? {
        OR: [
          { email: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ],
      }
    : {};

  // 并行查询总数和分页用户数据
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
        twoFactorEnabled: true,
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
              <th className="px-4 py-3 font-medium">{t('table.twoFactor')}</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
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
                  <td className="px-4 py-3">
                    <Reset2faButton userId={user.id} enabled={user.twoFactorEnabled} />
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
