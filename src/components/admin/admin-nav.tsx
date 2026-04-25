'use client';

import { CreditCard, LayoutDashboard, ScrollText, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link, usePathname } from '@/i18n/routing';
import { cn } from '@/lib/utils';

const items = [
  { href: '/admin', icon: LayoutDashboard, key: 'overview' },
  { href: '/admin/users', icon: Users, key: 'users' },
  { href: '/admin/subscriptions', icon: CreditCard, key: 'subscriptions' },
  { href: '/admin/audit', icon: ScrollText, key: 'audit' },
] as const;

export function AdminNav() {
  const pathname = usePathname();
  const t = useTranslations('admin.nav');

  return (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
        const Icon = item.icon;
        // /admin matches as exact, others as prefix
        const active =
          item.href === '/admin' ? pathname === item.href : pathname.startsWith(item.href);
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
