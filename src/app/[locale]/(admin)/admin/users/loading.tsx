import { TableSkeleton } from '@/components/admin/table-skeleton';

export default function AdminUsersLoading() {
  return <TableSkeleton rows={8} cols={5} />;
}
