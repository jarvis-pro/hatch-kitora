'use client';

import {
  CreditCard,
  KeyRound,
  LayoutDashboard,
  ListTodo,
  Receipt,
  ScrollText,
  Users,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link, usePathname } from '@/i18n/routing';
import { cn } from '@/lib/utils';

/**
 * 管理后台导航菜单项配置数组。
 * 每项包含路由路径、对应的图标组件和国际化文本 key。
 */
const items = [
  { href: '/admin', icon: LayoutDashboard, key: 'overview' },
  { href: '/admin/users', icon: Users, key: 'users' },
  { href: '/admin/subscriptions', icon: CreditCard, key: 'subscriptions' },
  { href: '/admin/api-tokens', icon: KeyRound, key: 'apiTokens' },
  { href: '/admin/stripe-events', icon: Receipt, key: 'stripeEvents' },
  { href: '/admin/audit', icon: ScrollText, key: 'audit' },
  { href: '/admin/jobs', icon: ListTodo, key: 'jobs' },
] as const;

/**
 * 管理后台导航栏组件。
 *
 * 根据当前路径名 `pathname` 判断各菜单项的激活状态，其中 `/admin` 路由
 * 要求精确匹配，其他菜单项则使用前缀匹配。被激活的菜单项呈现强调样式。
 *
 * @returns 包含多个导航链接的竖向菜单 nav 元素。
 */
export function AdminNav() {
  const pathname = usePathname();
  const t = useTranslations('admin.nav');

  return (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
        const Icon = item.icon;
        // /admin 路由精确匹配，其他路由使用前缀匹配判断激活态
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
