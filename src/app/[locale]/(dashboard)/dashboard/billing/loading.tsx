import { Skeleton } from '@/components/ui/skeleton';

/**
 * 计费页的加载占位符。
 *
 * 显示标题、订阅卡片和发票卡片的骨架屏。
 *
 * @returns 加载占位符 JSX 元素
 */
export default function BillingLoading() {
  return (
    <div className="space-y-6">
      {/* 页面标题和描述骨架屏 */}
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      {/* 订阅卡片骨架屏 */}
      <div className="space-y-3 rounded-xl border bg-card p-6">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-48" />
        {/* 订阅详情网格骨架屏 */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
        <Skeleton className="h-9 w-44" />
      </div>
    </div>
  );
}
