import { redirect } from 'next/navigation';

import { DashboardNav } from '@/components/dashboard/dashboard-nav';
import { OrgSwitcher } from '@/components/dashboard/org-switcher';
import { UserMenu } from '@/components/dashboard/user-menu';
import { DeletionBanner } from '@/components/account/deletion-banner';
import { auth } from '@/lib/auth';
import { listMyOrgs, requireActiveOrg } from '@/lib/auth/session';
import { prisma } from '@/lib/db';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const me = await requireActiveOrg().catch(() => null);
  if (!me) redirect('/login');

  const memberships = await listMyOrgs(me.userId);
  const switcherOptions = memberships.map((m) => ({
    slug: m.organization.slug,
    name: m.organization.name,
    role: m.role,
  }));
  // RFC 0002 PR-4 — 为处于 30 天宽限期的用户显示取消删除横幅。
  // 中间件已经将他们赶到 /settings，但横幅需要显示*这里*
  // 在布局中，以便当他们到达时取消 CTA 立即可见。
  //
  // Org-2FA 强制执行故意*不*在此布局级别完成——
  // /onboarding/2fa-required 墙壁页面也位于此布局内，
  // 布局级重定向会将其放在无限循环中。单个 RSC 页面
  // 调用 `checkOrg2faCompliance()` 以对其自身访问进行把关；
  // 墙壁页面仅在上游的门触发时才呈现。
  const lifecycle = await prisma.user.findUniqueOrThrow({
    where: { id: me.userId },
    select: { status: true, deletionScheduledAt: true },
  });
  const current = switcherOptions.find((o) => o.slug === me.slug) ?? {
    slug: me.slug,
    name: me.slug,
    role: me.role,
  };

  return (
    <div className="flex min-h-screen flex-col">
      {lifecycle.status === 'PENDING_DELETION' && lifecycle.deletionScheduledAt ? (
        <DeletionBanner scheduledAt={lifecycle.deletionScheduledAt} />
      ) : null}
      <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur md:px-6">
        <span className="text-lg font-semibold tracking-tight">Kitora</span>
        <span className="text-muted-foreground">/</span>
        <OrgSwitcher current={current} options={switcherOptions} />
        <div className="ml-auto">
          <UserMenu user={session.user} />
        </div>
      </header>
      <div className="container flex-1 grid-cols-[220px_1fr] gap-8 py-6 md:grid">
        <aside className="hidden md:block">
          <DashboardNav role={me.role} isPersonal={me.slug.startsWith('personal-')} />
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
