import { Skeleton } from '@/components/ui/skeleton';

interface Props {
  rows?: number;
  cols?: number;
  /** 是否在顶部渲染搜索栏 / 过滤芯片区域。 */
  withFilters?: boolean;
}

/**
 * 可重用的管理表加载骨架。镜像页面布局足够接近
 * 以避免在真实内容到达时布局移位。
 */
export function TableSkeleton({ rows = 8, cols = 5, withFilters = true }: Props) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>

      {withFilters ? (
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-7 w-20" />
          ))}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border">
        <div className="bg-muted/40 px-4 py-3">
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {Array.from({ length: cols }).map((_, i) => (
              <Skeleton key={i} className="h-3 w-20" />
            ))}
          </div>
        </div>
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="border-t px-4 py-3">
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
              {Array.from({ length: cols }).map((_, c) => (
                <Skeleton key={c} className="h-4 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
