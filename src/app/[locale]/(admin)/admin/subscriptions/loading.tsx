import { TableSkeleton } from '@/components/admin/table-skeleton';

export default function AdminSubscriptionsLoading() {
  return <TableSkeleton rows={8} cols={5} />;
}
