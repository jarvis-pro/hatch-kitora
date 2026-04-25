import { Skeleton } from '@/components/ui/skeleton';

export default function SettingsLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="space-y-3 rounded-xl border bg-card p-6">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}
