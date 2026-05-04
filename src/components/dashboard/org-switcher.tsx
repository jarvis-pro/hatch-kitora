'use client';

import { Building2, Check, ChevronsUpDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useRouter } from '@/i18n/routing';
import { setActiveOrgAction } from '@/services/orgs/actions';
import { cn } from '@/lib/utils';

export interface OrgOption {
  slug: string;
  name: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}

interface Props {
  current: { slug: string; name: string };
  options: OrgOption[];
}

export function OrgSwitcher({ current, options }: Props) {
  const t = useTranslations('orgs.switcher');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const onPick = (slug: string) => {
    if (slug === current.slug) return;
    startTransition(async () => {
      const result = await setActiveOrgAction({ slug });
      if (!result.ok) {
        toast.error(t('errors.switch'));
        return;
      }
      // server action 已经 revalidatePath('/', 'layout')，但客户端 router cache
      // 需要再 refresh 一次才会拿到带新 cookie 的 RSC payload。
      router.refresh();
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 max-w-[180px] gap-2 px-2"
          aria-label={t('label')}
        >
          <Building2 className="size-4 text-muted-foreground" />
          <span className="truncate text-sm">{current.name}</span>
          <ChevronsUpDown className="ml-auto size-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>{t('label')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.map((org) => {
          const active = org.slug === current.slug;
          return (
            <DropdownMenuItem
              key={org.slug}
              disabled={pending}
              onSelect={() => onPick(org.slug)}
              className={cn('flex items-center justify-between gap-2', active && 'font-medium')}
            >
              <span className="truncate">{org.name}</span>
              {active ? <Check className="size-4 text-primary" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
