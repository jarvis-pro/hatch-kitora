'use client';

import { LogOut, User as UserIcon } from 'lucide-react';
import { signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Link } from '@/i18n/routing';

/**
 * 用户菜单组件的 props 接口。
 *
 * @property user - 当前用户信息对象，包含 name、email 和 image。
 */
interface UserMenuProps {
  user: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
  };
}

/**
 * 用户菜单下拉框组件。
 *
 * 在导航栏右上角显示用户头像，点击后展开下拉菜单。菜单包含用户信息、
 * 设置链接和登出按钮。头像可显示用户图片，若无图片则显示用户名或邮箱
 * 的首字母缩写。
 *
 * @param props - 组件 props，包含 user 对象。
 * @returns 包含触发按钮和下拉菜单内容的 DropdownMenu 组件。
 */
export function UserMenu({ user }: UserMenuProps) {
  const t = useTranslations('dashboard.userMenu');
  // 从用户名或邮箱提取首字母缩写，最多两个字符
  const initials = (user.name ?? user.email ?? 'U').slice(0, 2).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="relative size-9 rounded-full p-0">
          <Avatar className="size-9">
            {user.image ? <AvatarImage src={user.image} alt={user.name ?? ''} /> : null}
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <p className="text-sm font-medium">{user.name ?? t('account')}</p>
          {user.email ? <p className="text-xs text-muted-foreground">{user.email}</p> : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <UserIcon />
            {t('settings')}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => signOut({ callbackUrl: '/' })}>
          <LogOut />
          {t('signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
