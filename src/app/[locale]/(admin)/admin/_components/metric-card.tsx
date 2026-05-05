import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * 指标卡片组件的 props 接口。
 *
 * @property label - 指标标题标签，通常为指标名称。
 * @property value - 指标的数值或文本内容，以大号字体显示。
 * @property hint - 可选的辅助说明文本，显示在数值下方。
 * @property className - 可选的额外 Tailwind CSS 类名，用于自定义卡片样式。
 */
interface MetricCardProps {
  label: string;
  value: string;
  hint?: string;
  className?: string;
}

/**
 * 指标卡片组件。
 *
 * 展示单个数据指标，包含标题、数值和可选的提示文本。常用于仪表板、
 * 数据分析页面展示关键业务指标（如用户数、收入等）。
 *
 * @param props - 组件 props，包含 label、value、hint 和 className。
 * @returns 布局为竖向的卡片元素，包含标题、主数值和可选提示。
 */
export function MetricCard({ label, value, hint, className }: MetricCardProps) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold tracking-tight">{value}</div>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}
