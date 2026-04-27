import { Skeleton } from '@/components/ui/skeleton';

/**
 * 管理员概览页的加载占位符。
 *
 * 显示标题、描述及 4 列统计卡片的骨架屏。
 *
 * @returns 加载占位符 JSX 元素
 */
export default function AdminOverviewLoading() {
  return (
    <div className="space-y-6">
      {/* 页面标题和描述骨架屏 */}
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>
      {/* 4 列统计卡片骨架屏 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-3 rounded-xl border bg-card p-6">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-8 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
