import { TableSkeleton } from '@/components/admin/table-skeleton';

export default function AdminStripeEventsLoading() {
  return <TableSkeleton rows={10} cols={3} />;
}
