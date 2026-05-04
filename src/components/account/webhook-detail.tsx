'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { updateWebhookEndpointAction } from '@/services/orgs/webhook-endpoints';
import { WEBHOOK_EVENTS } from '@/services/webhooks/events';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';

/**
 * Webhook 端点详情数据结构
 */
export interface WebhookEndpointDetail {
  id: string;
  url: string;
  description: string | null;
  enabledEvents: string[];
  secretPrefix: string;
  disabledAt: Date | null;
  consecutiveFailures: number;
  createdAt: Date;
}

/**
 * WebhookDetail 组件 Props
 * @property {string} orgSlug - 组织 slug
 * @property {WebhookEndpointDetail} endpoint - Webhook 端点详情
 */
interface Props {
  orgSlug: string;
  endpoint: WebhookEndpointDetail;
}

/**
 * Webhook 端点详情编辑表单组件
 * RFC 0003 PR-1 — Webhook 端点编辑表单。发送记录部分在 PR-1 中故意留空；
 * PR-2 中当定时任务开始投递且存在记录时会填充该部分。
 * @param {Props} props
 * @returns Webhook 端点编辑表单
 */
export function WebhookDetail({ orgSlug, endpoint }: Props) {
  const t = useTranslations('orgs.webhooks');
  const format = useFormatter();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [url, setUrl] = useState(endpoint.url);
  const [description, setDescription] = useState(endpoint.description ?? '');
  const [chosenEvents, setChosenEvents] = useState<string[]>(endpoint.enabledEvents);
  // 跟踪是否已禁用端点
  const [disabled, setDisabled] = useState(endpoint.disabledAt !== null);

  /**
   * 切换事件订阅
   * @param e - 事件类型
   */
  const toggleEvent = (e: string) =>
    setChosenEvents((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));

  /**
   * 保存 Webhook 端点配置
   */
  const onSave = () => {
    startTransition(async () => {
      // 调用服务端 action 更新 webhook 端点
      const result = await updateWebhookEndpointAction({
        orgSlug,
        id: endpoint.id,
        url,
        description: description.trim() || null,
        enabledEvents: chosenEvents,
        disabledAt: disabled ? new Date() : null,
      });
      if (result.ok) {
        toast.success(t('actions.save'));
        router.refresh();
        return;
      }
      // 错误处理：URL 验证、协议检查、主机阻止等
      const map: Record<string, string> = {
        'invalid-url': t('errors.invalidUrl'),
        'bad-protocol': t('errors.badProtocol'),
        'blocked-host': t('errors.blockedHost'),
        forbidden: t('errors.forbidden'),
        'invalid-input': t('errors.generic'),
        'not-found': t('errors.generic'),
      };
      if (result.error === 'unknown-event') {
        toast.error(t('errors.unknownEvent', { bad: result.bad ?? '' }));
      } else {
        toast.error(map[result.error] ?? t('errors.generic'));
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1 text-sm text-muted-foreground">
        <div>
          <code className="font-mono">whsec_…{endpoint.secretPrefix}</code>
        </div>
        <div>
          {format.dateTime(endpoint.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
        </div>
        {endpoint.consecutiveFailures > 0 ? (
          <div className="text-amber-700 dark:text-amber-400">
            consecutiveFailures = {endpoint.consecutiveFailures}
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="webhook-url">{t('fields.url')}</Label>
        <Input id="webhook-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="webhook-description">{t('fields.description')}</Label>
        <Input
          id="webhook-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={200}
        />
      </div>

      <div className="space-y-2">
        <Label>{t('fields.events')}</Label>
        <div className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
          {WEBHOOK_EVENTS.map((e) => (
            <label key={e} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={chosenEvents.includes(e)}
                onChange={() => toggleEvent(e)}
              />
              <code className="font-mono text-xs">{e}</code>
            </label>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
        {t('status.disabled')}
      </label>

      <Button onClick={onSave} disabled={pending}>
        {pending ? t('actions.saving') : t('actions.save')}
      </Button>
    </div>
  );
}
