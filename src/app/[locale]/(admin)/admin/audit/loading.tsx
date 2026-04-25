import { TableSkeleton } from '@/components/admin/table-skeleton';

export default function AdminAuditLoading() {
  return <TableSkeleton rows={10} cols={6} />;
}
