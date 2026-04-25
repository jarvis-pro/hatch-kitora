import type { SubscriptionStatus } from '@prisma/client';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';

const STYLES: Record<SubscriptionStatus, string> = {
  ACTIVE: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  TRIALING: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  PAST_DUE: 'bg-amber-500/15 text-amber-700 dark:text-amber-500',
  CANCELED: 'bg-zinc-500/15 text-zinc-700 dark:text-zinc-400',
  INCOMPLETE: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  INCOMPLETE_EXPIRED: 'bg-red-500/15 text-red-700 dark:text-red-400',
  UNPAID: 'bg-red-500/15 text-red-700 dark:text-red-400',
};

interface Props {
  status: SubscriptionStatus;
}

export function SubscriptionStatusBadge({ status }: Props) {
  const t = useTranslations('billing.status');
  return (
    <span className={cn('rounded-md px-2 py-0.5 text-xs font-medium', STYLES[status])}>
      {t(status)}
    </span>
  );
}
