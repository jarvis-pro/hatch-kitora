import { TableSkeleton } from '@/components/admin/table-skeleton';

export default function AdminApiTokensLoading() {
  return <TableSkeleton rows={8} cols={7} />;
}
