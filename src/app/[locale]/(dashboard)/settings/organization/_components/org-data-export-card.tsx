'use client';

import type { DataExportStatus } from '@prisma/client';
import { useFormatter, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { triggerOrgExportAction } from '@/services/account/data-export';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/routing';

/**
 * 组织数据导出任务行数据结构
 */
export interface OrgDataExportRow {
  id: string;
  status: DataExportStatus;
  sizeBytes: number | null;
  createdAt: Date;
  expiresAt: Date | null;
}

/**
 * OrgDataExportCard 组件 Props
 * @property {string} orgSlug - 组织 slug
 * @property {OrgDataExportRow[]} jobs - 历史导出任务列表
 */
interface Props {
  orgSlug: string;
  jobs: OrgDataExportRow[];
}

/**
 * 格式化字节大小为可读的单位（B/KB/MB）
 * @param bytes - 字节数，null 时返回连字符
 * @returns 格式化后的大小字符串
 */
function formatSize(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 组织数据导出卡片组件
 * RFC 0002 PR-3 — 仅 OWNER 可导出整个组织数据。服务端 action 是权限校验的真实来源；
 * 此 UI 仅在非 OWNER 时隐藏按钮（父页面处理可见性）。
 * @param {Props} props
 * @returns 组织数据导出界面
 */
export function OrgDataExportCard({ orgSlug, jobs }: Props) {
  const t = useTranslations('account.dataExport');
  const format = useFormatter();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  /**
   * 请求导出组织数据
   */
  const onRequest = () => {
    startTransition(async () => {
      // 调用服务端 action 触发组织数据导出任务
      const result = await triggerOrgExportAction({ orgSlug });
      if (result.ok) {
        toast.success(t('queued'));
        router.refresh();
        return;
      }
      // 处理速率限制错误
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
          <ul className="space-y-2 text-sm">
            {jobs.map((j) => (
              <li
                key={j.id}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <div className="space-y-0.5">
                  <div className="text-xs text-muted-foreground">
                    {format.dateTime(j.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{t(`status.${j.status}`)}</span>
                    <span className="text-xs text-muted-foreground">·</span>
                    <span className="text-xs text-muted-foreground">{formatSize(j.sizeBytes)}</span>
                    {j.expiresAt ? (
                      <>
                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs text-muted-foreground">
                          {format.dateTime(j.expiresAt, { dateStyle: 'short' })}
                        </span>
                      </>
                    ) : null}
                  </div>
                </div>
                {j.status === 'COMPLETED' ? (
                  <a
                    href={`/api/exports/${j.id}/download`}
                    className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t('download')}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
