import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface DataPaginationProps {
  /** 不含分页查询的基础 href（例如 "/admin/users?q=foo&"）。组件
   *  会追加 `page=N`。 */
  baseHref: string;
  page: number;
  pageSize: number;
  total: number;
}

/**
 * 服务器组件分页 — 使用普通 `next/link`（非 i18n 的 `Link`）
 * 因为 URL 包含查询参数，我们想逐字保留。
 */
export function DataPagination({ baseHref, page, pageSize, total }: DataPaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const prev = Math.max(1, page - 1);
  const next = Math.min(totalPages, page + 1);
  const sep = baseHref.includes('?') ? '&' : '?';
  const href = (p: number) => `${baseHref}${sep}page=${p}`;

  return (
    <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
      <span>
        Page {page} of {totalPages} · {total.toLocaleString()} total
      </span>
      <div className="flex gap-2">
        <Button asChild variant="outline" size="sm" disabled={page <= 1}>
          <Link
            href={href(prev)}
            aria-disabled={page <= 1}
            className={cn(page <= 1 && 'pointer-events-none opacity-50')}
          >
            Prev
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm" disabled={page >= totalPages}>
          <Link
            href={href(next)}
            aria-disabled={page >= totalPages}
            className={cn(page >= totalPages && 'pointer-events-none opacity-50')}
          >
            Next
          </Link>
        </Button>
      </div>
    </div>
  );
}
