'use client';

import type { WebhookDeliveryStatus } from '@prisma/client';
import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { resendWebhookDeliveryAction } from '@/services/orgs/webhook-endpoints';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/routing';

/**
 * Webhook 发送记录行数据结构
 */
export interface WebhookDeliveryRow {
  id: string;
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempt: number;
  responseStatus: number | null;
  errorMessage: string | null;
  payload: unknown;
  responseBody: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

/**
 * WebhookDeliveries 组件 Props
 * @property {string} orgSlug - 组织 slug
 * @property {string} endpointId - Webhook 端点 ID
 * @property {WebhookDeliveryRow[]} deliveries - 发送记录列表
 */
interface Props {
  orgSlug: string;
  endpointId: string;
  deliveries: WebhookDeliveryRow[];
}

/**
 * Webhook 发送记录面板组件
 * RFC 0003 PR-2 — 表格展示最近 50 条发送记录。点击行可展开查看签名的请求数据和响应体。
 * 非 PENDING 状态的记录支持重新发送功能，允许将 DEAD_LETTER 状态重新放入队列而无需重新触发源事件。
 * @param {Props} props
 * @returns Webhook 发送记录面板
 */
export function WebhookDeliveries({ orgSlug, endpointId, deliveries }: Props) {
  const t = useTranslations('orgs.webhooks');
  const format = useFormatter();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState<string | null>(null);

  /**
   * 重新发送 Webhook 记录
   * @param deliveryId - 发送记录 ID
   */
  const onResend = (deliveryId: string) => {
    startTransition(async () => {
      // 调用服务端 action 重新发送 webhook
      const result = await resendWebhookDeliveryAction({ orgSlug, endpointId, deliveryId });
      if (result.ok) {
        toast.success(t('deliveries.resent'));
        router.refresh();
      } else {
        toast.error(t('errors.generic'));
      }
    });
  };

  if (deliveries.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('deliveries.empty')}</p>;
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">{t('deliveries.event')}</th>
            <th className="px-3 py-2 font-medium">{t('deliveries.status')}</th>
            <th className="px-3 py-2 font-medium">{t('deliveries.attempt')}</th>
            <th className="px-3 py-2 font-medium">{t('deliveries.responseCode')}</th>
            <th className="px-3 py-2 font-medium">{t('deliveries.createdAt')}</th>
            <th className="px-3 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {deliveries.map((d) => {
            const open = expanded === d.id;
            return (
              <DeliveryFragment
                key={d.id}
                d={d}
                open={open}
                pending={pending}
                onToggle={() => setExpanded(open ? null : d.id)}
                onResend={() => onResend(d.id)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );

  /**
   * Webhook 发送记录展开行片段
   * @param d - 发送记录数据
   * @param open - 是否展开显示详情
   * @param pending - 是否正在操作中
   * @param onToggle - 切换展开/收起的回调
   * @param onResend - 重新发送的回调
   * @returns 发送记录表格行和详情展开行
   */
  function DeliveryFragment({
    d,
    open,
    pending,
    onToggle,
    onResend,
  }: {
    d: WebhookDeliveryRow;
    open: boolean;
    pending: boolean;
    onToggle: () => void;
    onResend: () => void;
  }) {
    return (
      <>
        <tr className="border-t">
          <td className="px-3 py-2">
            <button
              type="button"
              onClick={onToggle}
              className="font-mono text-xs text-primary underline-offset-4 hover:underline"
            >
              {d.eventType}
            </button>
            <div className="text-xs text-muted-foreground">{d.eventId}</div>
          </td>
          <td className="px-3 py-2">
            <StatusBadge status={d.status} />
          </td>
          <td className="px-3 py-2 text-muted-foreground">{d.attempt}</td>
          <td className="px-3 py-2 text-muted-foreground">
            {d.responseStatus ?? <span className="text-muted-foreground/60">—</span>}
          </td>
          <td className="px-3 py-2 text-muted-foreground">
            {format.dateTime(d.createdAt, { dateStyle: 'short', timeStyle: 'medium' })}
          </td>
          <td className="px-3 py-2">
            {/* 仅对非 PENDING/RETRYING 状态的记录显示重新发送按钮 */}
            <Button
              variant="outline"
              size="sm"
              disabled={pending || d.status === 'PENDING' || d.status === 'RETRYING'}
              onClick={onResend}
            >
              {pending ? t('deliveries.resending') : t('deliveries.resend')}
            </Button>
          </td>
        </tr>
        {/* 展开行显示请求数据和响应体 */}
        {open ? (
          <tr className="border-t bg-muted/20">
            <td colSpan={6} className="px-3 py-2">
              <div className="space-y-2 font-mono text-xs">
                <details open>
                  <summary className="cursor-pointer">{t('deliveries.payload')}</summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-background p-2">
                    {JSON.stringify(d.payload, null, 2)}
                  </pre>
                </details>
                {d.responseBody ? (
                  <details>
                    <summary className="cursor-pointer">{t('deliveries.responseBody')}</summary>
                    <pre className="mt-1 overflow-x-auto rounded bg-background p-2">
                      {d.responseBody}
                    </pre>
                  </details>
                ) : null}
                {d.errorMessage ? <p className="text-destructive">{d.errorMessage}</p> : null}
              </div>
            </td>
          </tr>
        ) : null}
      </>
    );
  }

  /**
   * Webhook 发送记录状态徽章
   * @param status - 发送状态
   * @returns 带样式的状态徽章
   */
  function StatusBadge({ status }: { status: WebhookDeliveryStatus }) {
    // 根据发送状态返回相应的样式类
    const tone =
      status === 'DELIVERED'
        ? 'bg-emerald-500/10 text-emerald-700'
        : status === 'DEAD_LETTER'
          ? 'bg-destructive/10 text-destructive'
          : status === 'CANCELED'
            ? 'bg-muted text-muted-foreground'
            : 'bg-primary/10 text-primary';
    return (
      <span className={`rounded px-2 py-0.5 text-xs font-medium ${tone}`}>
        {t(`deliveries.statusName.${status}`)}
      </span>
    );
  }
}
