import { Skeleton } from '@/components/ui/skeleton';

/**
 * 设置页的加载占位符。
 *
 * 显示标题、描述及 4 个设置卡片的骨架屏。
 *
 * @returns 加载占位符 JSX 元素
 */
export default function SettingsLoading() {
  return (
    <div className="space-y-6">
      {/* 页面标题和描述骨架屏 */}
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      {/* 4 个设置卡片骨架屏 */}
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="space-y-3 rounded-xl border bg-card p-6">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}
