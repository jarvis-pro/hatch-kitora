'use client';

import type { DataExportStatus } from '@prisma/client';
import { useFormatter, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { triggerUserExportAction } from '@/lib/account/data-export';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/routing';

export interface DataExportRow {
  id: string;
  status: DataExportStatus;
  sizeBytes: number | null;
  createdAt: Date;
  expiresAt: Date | null;
}

interface Props {
  jobs: DataExportRow[];
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function DataExportCard({ jobs }: Props) {
  const t = useTranslations('account.dataExport');
  const format = useFormatter();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const onRequest = () => {
    startTransition(async () => {
      const result = await triggerUserExportAction();
      if (result.ok) {
        toast.success(t('queued'));
        router.refresh();
        return;
      }
      if (result.error === 'rate-limited') {
        toast.error(
          t('errors.rateLimited', {
            at: format.dateTime(new Date(result.retryAfter), {
              dateStyle: 'short',
              timeStyle: 'short',
            }),
          }),
        );
        return;
      }
      toast.error(t('errors.generic'));
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{t('description')}</p>
        <p className="text-xs text-muted-foreground">{t('limit')}</p>
        <Button onClick={onRequest} disabled={pending}>
          {pending ? t('requesting') : t('request')}
        </Button>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-semibold">{t('history')}</h4>
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('table.createdAt')}</th>
                  <th className="px-3 py-2 font-medium">{t('table.status')}</th>
                  <th className="px-3 py-2 font-medium">{t('table.size')}</th>
                  <th className="px-3 py-2 font-medium">{t('table.expiresAt')}</th>
                  <th className="px-3 py-2 font-medium">{t('table.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-t">
                    <td className="px-3 py-2 text-muted-foreground">
                      {format.dateTime(j.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={j.status} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{formatSize(j.sizeBytes)}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {j.expiresAt ? format.dateTime(j.expiresAt, { dateStyle: 'short' }) : '—'}
                    </td>
                    <td className="px-3 py-2">
                      {j.status === 'COMPLETED' ? (
                        <a
                          href={`/api/exports/${j.id}/download`}
                          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {t('download')}
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );

  function StatusBadge({ status }: { status: DataExportStatus }) {
    const tone =
      status === 'COMPLETED'
        ? 'bg-emerald-500/10 text-emerald-700'
        : status === 'FAILED'
          ? 'bg-destructive/10 text-destructive'
          : status === 'EXPIRED'
            ? 'bg-muted text-muted-foreground'
            : 'bg-primary/10 text-primary';
    return (
      <span className={`rounded px-2 py-0.5 text-xs font-medium ${tone}`}>
        {t(`status.${status}`)}
      </span>
    );
  }
}
