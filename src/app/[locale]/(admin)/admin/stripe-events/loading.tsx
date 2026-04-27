import { TableSkeleton } from '@/components/admin/table-skeleton';

/**
 * Stripe 事件日志页的加载占位符。
 *
 * 显示 10 行 3 列的表格骨架屏。
 *
 * @returns 加载占位符 JSX 元素
 */
export default function AdminStripeEventsLoading() {
  return <TableSkeleton rows={10} cols={3} />;
}
