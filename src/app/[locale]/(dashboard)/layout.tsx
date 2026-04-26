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
  // RFC 0002 PR-4 — show the cancel-deletion banner for users in the
  // 30-day grace window. The middleware already herds them to /settings,
  // but the banner needs to appear *here* in the layout so the cancel
  // CTA is visible the moment they land.
  //
  // Org-2FA enforcement is intentionally *not* done at this layout level
  // — the /onboarding/2fa-required wall page lives inside this layout
  // too, and a layout-level redirect would put it in an infinite loop.
  // Individual RSC pages call `checkOrg2faCompliance()` to gate their
  // own access; the wall page renders only when the gate fires upstream.
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
