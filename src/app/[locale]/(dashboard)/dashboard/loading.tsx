import { Skeleton } from '@/components/ui/skeleton';

/**
 * 仪表板页的加载占位符。
 *
 * 显示标题、描述及 3 张统计卡片的骨架屏。
 *
 * @returns 加载占位符 JSX 元素
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-6">
      {/* 页面标题和描述骨架屏 */}
      <div className="space-y-2">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-96" />
      </div>
      {/* 3 列统计卡片骨架屏 */}
      <div className="grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-3 rounded-xl border bg-card p-6">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-3 w-40" />
          </div>
        ))}
      </div>
    </div>
  );
}
