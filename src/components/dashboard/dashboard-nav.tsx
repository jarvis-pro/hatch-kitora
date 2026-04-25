'use client';

import { CreditCard, LayoutDashboard, Settings } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link, usePathname } from '@/i18n/routing';
import { cn } from '@/lib/utils';

const items = [
  { href: '/dashboard', icon: LayoutDashboard, key: 'home' },
  { href: '/dashboard/billing', icon: CreditCard, key: 'billing' },
  { href: '/settings', icon: Settings, key: 'settings' },
] as const;

export function DashboardNav() {
  const pathname = usePathname();
  const t = useTranslations('dashboard.nav');

  return (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
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
