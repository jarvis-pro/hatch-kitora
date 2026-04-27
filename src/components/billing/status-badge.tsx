import type { SubscriptionStatus } from '@prisma/client';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';

/**
 * 订阅状态徽章的样式映射。
 * 根据 Prisma SubscriptionStatus 枚举值返回相应的颜色样式。
 */
const STYLES: Record<SubscriptionStatus, string> = {
  ACTIVE: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  TRIALING: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  PAST_DUE: 'bg-amber-500/15 text-amber-700 dark:text-amber-500',
  CANCELED: 'bg-zinc-500/15 text-zinc-700 dark:text-zinc-400',
  INCOMPLETE: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  INCOMPLETE_EXPIRED: 'bg-red-500/15 text-red-700 dark:text-red-400',
  UNPAID: 'bg-red-500/15 text-red-700 dark:text-red-400',
};

/**
 * 订阅状态徽章组件的 props 接口。
 *
 * @property status - 订阅状态值，来自 Prisma 的 SubscriptionStatus 枚举。
 */
interface Props {
  status: SubscriptionStatus;
}

/**
 * 订阅状态徽章组件。
 *
 * 以彩色徽章形式展示订阅状态（如 ACTIVE、TRIALING、CANCELED 等），
 * 不同状态使用不同的颜色进行视觉区分，便于用户一目了然地了解
 * 订阅当前的状态。
 *
 * @param props - 组件 props，包含 status。
 * @returns 包含本地化状态文本的彩色徽章 span 元素。
 */
export function SubscriptionStatusBadge({ status }: Props) {
  const t = useTranslations('billing.status');
  return (
    <span className={cn('rounded-md px-2 py-0.5 text-xs font-medium', STYLES[status])}>
      {t(status)}
    </span>
  );
}
