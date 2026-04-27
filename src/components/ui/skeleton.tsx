import { cn } from '@/lib/utils';

/**
 * 骨架屏组件。用于显示加载占位符，提供脉动动画效果。
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}
