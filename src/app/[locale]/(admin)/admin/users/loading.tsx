import { TableSkeleton } from '../_components/table-skeleton';

/**
 * 用户管理页的加载占位符。
 *
 * 显示 8 行 5 列的表格骨架屏。
 *
 * @returns 加载占位符 JSX 元素
 */
export default function AdminUsersLoading() {
  return <TableSkeleton rows={8} cols={5} />;
}
