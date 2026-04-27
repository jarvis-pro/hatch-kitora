import { redirect } from 'next/navigation';

import { AdminNav } from '@/components/admin/admin-nav';
import { UserMenu } from '@/components/dashboard/user-menu';
import { auth } from '@/lib/auth';

/**
 * 管理员布局——第二层防御。
 *
 * 中间件已经将非管理员从 /admin/* 重定向，但我们在这里
 * 服务端重新检查角色，以便对匹配器的任何未来更改都不会
 * 静默地暴露管理路由。
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (!session?.user) {
    redirect('/login');
  }
  if (session.user.role !== 'ADMIN') {
    redirect('/dashboard');
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b bg-background/80 px-4 backdrop-blur md:px-6">
        <span className="text-lg font-semibold tracking-tight">Kitora</span>
        <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
          Admin
        </span>
        <div className="ml-auto">
          <UserMenu user={session.user} />
        </div>
      </header>
      <div className="container flex-1 grid-cols-[220px_1fr] gap-8 py-6 md:grid">
        <aside className="hidden md:block">
          <AdminNav />
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
