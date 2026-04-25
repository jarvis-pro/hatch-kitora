import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';
import { DashboardNav } from '@/components/dashboard/dashboard-nav';
import { UserMenu } from '@/components/dashboard/user-menu';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (!session?.user) {
    redirect('/login');
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b bg-background/80 px-4 backdrop-blur md:px-6">
        <span className="text-lg font-semibold tracking-tight">Kitora</span>
        <div className="ml-auto">
          <UserMenu user={session.user} />
        </div>
      </header>
      <div className="container flex-1 grid-cols-[220px_1fr] gap-8 py-6 md:grid">
        <aside className="hidden md:block">
          <DashboardNav />
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
