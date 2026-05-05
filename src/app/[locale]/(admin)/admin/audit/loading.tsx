import { TableSkeleton } from '../_components/table-skeleton';

/**
 * 审计日志页的加载占位符。
 *
 * 显示 10 行 6 列的表格骨架屏。
 *
 * @returns 加载占位符 JSX 元素
 */
export default function AdminAuditLoading() {
  return <TableSkeleton rows={10} cols={6} />;
}
