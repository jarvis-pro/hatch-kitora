'use client';

import { Building2, CreditCard, LayoutDashboard, Settings, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link, usePathname } from '@/i18n/routing';
import { cn } from '@/lib/utils';
import type { OrgRole } from '@prisma/client';

/**
 * 仪表板导航菜单项接口。
 * 定义了菜单项的路由、图标、国际化 key 和可见性控制参数。
 *
 * @property href - 菜单项指向的路由路径。
 * @property icon - React 图标组件。
 * @property key - 国际化翻译 key。
 * @property managementOnly - 当为 true 时，仅 OWNER/ADMIN 角色可见。
 * @property hideOnPersonal - 当为 true 时，在个人组织中隐藏该菜单项。
 */
interface NavItem {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  key: string;
  managementOnly?: boolean;
  hideOnPersonal?: boolean;
}

/**
 * 仪表板导航菜单项配置数组。
 * 包含首页、计费、设置、成员管理和组织设置等菜单项。
 */
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

/**
 * 仪表板导航组件的 props 接口。
 *
 * @property role - 用户在当前组织中的角色，来自 Prisma 的 OrgRole 枚举。
 * @property isPersonal - 是否为个人组织。
 */
interface Props {
  role: OrgRole;
  isPersonal: boolean;
}

/**
 * 仪表板导航栏组件。
 *
 * 根据用户角色和组织类型动态展示菜单项。OWNER/ADMIN 角色可见
 * 管理类菜单（成员、组织设置）；个人组织中隐藏成员和组织设置菜单。
 * 当前路径精确匹配时，菜单项呈现激活样式。
 *
 * @param props - 组件 props，包含 role 和 isPersonal。
 * @returns 竖向菜单 nav 元素，包含根据权限过滤后的导航链接。
 */
export function DashboardNav({ role, isPersonal }: Props) {
  const pathname = usePathname();
  const t = useTranslations('dashboard.nav');
  // 判断当前用户是否有管理权限
  const canManage = role === 'OWNER' || role === 'ADMIN';

  return (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
        // 非管理员隐藏管理专用菜单项
        if (item.managementOnly && !canManage) return null;
        // 个人组织中隐藏特定菜单项
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
