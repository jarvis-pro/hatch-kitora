'use client';

import { Building2, CreditCard, LayoutDashboard, Settings, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link, usePathname } from '@/i18n/routing';
import { cn } from '@/lib/utils';
import type { OrgRole } from '@prisma/client';

interface NavItem {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  key: string;
  /** Hide for non-OWNER/ADMIN roles. Members shouldn't see invite UI etc. */
  managementOnly?: boolean;
  /** Hide on personal orgs (members / org settings make no sense there). */
  hideOnPersonal?: boolean;
}

const items: readonly NavItem[] = [
  { href: '/dashboard', icon: LayoutDashboard, key: 'home' },
  { href: '/dashboard/billing', icon: CreditCard, key: 'billing' },
  { href: '/settings', icon: Settings, key: 'settings' },
  { href: '/settings/members', icon: Users, key: 'members', hideOnPersonal: true },
  {
    href: '/settings/organization',
    icon: Building2,
    key: 'organization',
    managementOnly: true,
    hideOnPersonal: true,
  },
];

interface Props {
  role: OrgRole;
  isPersonal: boolean;
}

export function DashboardNav({ role, isPersonal }: Props) {
  const pathname = usePathname();
  const t = useTranslations('dashboard.nav');
  const canManage = role === 'OWNER' || role === 'ADMIN';

  return (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
        if (item.managementOnly && !canManage) return null;
        if (item.hideOnPersonal && isPersonal) return null;
        const Icon = item.icon;
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
              active
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <Icon className="size-4" />
            {t(item.key)}
          </Link>
        );
      })}
    </nav>
  );
}
