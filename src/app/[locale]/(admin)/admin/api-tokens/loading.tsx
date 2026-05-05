import { TableSkeleton } from '../_components/table-skeleton';

/**
 * API 令牌列表页的加载占位符。
 *
 * 显示 8 行 7 列的表格骨架屏。
 *
 * @returns 加载占位符 JSX 元素
 */
export default function AdminApiTokensLoading() {
  return <TableSkeleton rows={8} cols={7} />;
}
