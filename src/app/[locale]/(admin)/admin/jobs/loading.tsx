/**
 * 任务管理页的加载占位符。
 *
 * 显示标题、筛选器、统计卡片和数据表的骨架屏布局。
 *
 * @returns 加载占位符 JSX 元素
 */
export default function AdminJobsLoading() {
  return (
    <div className="space-y-6">
      {/* 页面标题骨架屏 */}
      <div className="h-8 w-64 animate-pulse rounded bg-muted" />
      {/* 筛选器骨架屏 */}
      <div className="h-10 w-96 animate-pulse rounded bg-muted" />
      {/* 3 列统计卡片骨架屏 */}
      <div className="grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg border bg-muted/30" />
        ))}
      </div>
      {/* 数据表骨架屏 */}
      <div className="h-64 animate-pulse rounded-lg border bg-muted/20" />
    </div>
  );
}
