'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  createWebhookEndpointAction,
  deleteWebhookEndpointAction,
  rotateWebhookSecretAction,
} from '@/lib/orgs/webhook-endpoints';
import { WEBHOOK_EVENTS } from '@/lib/webhooks/events';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Link, useRouter } from '@/i18n/routing';

export interface WebhookEndpointRow {
  id: string;
  url: string;
  description: string | null;
  enabledEvents: string[];
  secretPrefix: string;
  disabledAt: Date | null;
  createdAt: Date;
}

interface Props {
  orgSlug: string;
  endpoints: WebhookEndpointRow[];
}

/**
 * RFC 0003 PR-1 — webhook endpoint list + create form + reveal-once
 * secret modal. Detail page (separate file) handles edit / rotate / delete
 * + the deliveries table that lights up in PR-2.
 */
export function WebhookEndpoints({ orgSlug, endpoints }: Props) {
  const t = useTranslations('orgs.webhooks');
  const format = useFormatter();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [chosenEvents, setChosenEvents] = useState<string[]>([...WEBHOOK_EVENTS]);
  const [revealed, setRevealed] = useState<{ secret: string } | null>(null);

  const toggleEvent = (e: string) =>
    setChosenEvents((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));

  const onCreate = () => {
    startTransition(async () => {
      const result = await createWebhookEndpointAction({
        orgSlug,
        url: url.trim(),
        description: description.trim() || undefined,
        enabledEvents: chosenEvents,
      });
      if (!result.ok) {
        const map: Record<string, string> = {
          'invalid-url': t('errors.invalidUrl'),
          'bad-protocol': t('errors.badProtocol'),
          'blocked-host': t('errors.blockedHost'),
          forbidden: t('errors.forbidden'),
          'invalid-input': t('errors.generic'),
        };
        if (result.error === 'unknown-event') {
          toast.error(t('errors.unknownEvent', { bad: result.bad ?? '' }));
        } else {
          toast.error(map[result.error] ?? t('errors.generic'));
        }
        return;
      }
      setRevealed({ secret: result.secret });
      setUrl('');
      setDescription('');
      router.refresh();
    });
  };

  const onDelete = (id: string) => {
    if (!confirm(t('actions.deleteConfirm'))) return;
    startTransition(async () => {
      const result = await deleteWebhookEndpointAction({ orgSlug, id });
      if (result.ok) {
        toast.success(t('actions.delete'));
        router.refresh();
      } else {
        toast.error(t('errors.generic'));
      }
    });
  };

  const onRotate = (id: string) => {
    if (!confirm(t('actions.rotateConfirm'))) return;
    startTransition(async () => {
      const result = await rotateWebhookSecretAction({ orgSlug, id });
      if (result.ok) {
        setRevealed({ secret: result.secret });
        router.refresh();
      } else {
        toast.error(t('errors.generic'));
      }
    });
  };

  const onCopy = async (raw: string) => {
    try {
      await navigator.clipboard.writeText(raw);
      toast.success(t('secretRevealed.copy'));
    } catch {
      // Clipboard may fail silently on some Safari/HTTP combos — non-fatal.
    }
  };

  return (
    <div className="space-y-6">
      {/* Create form */}
      <div className="space-y-3 rounded-md border p-4">
        <div className="space-y-2">
          <Label htmlFor="webhook-url">{t('fields.url')}</Label>
          <Input
            id="webhook-url"
            type="url"
            placeholder={t('fields.urlPlaceholder')}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
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
        <Button onClick={onCreate} disabled={pending || !url.trim()}>
          {pending ? t('creating') : t('create')}
        </Button>
      </div>

      {/* One-time reveal */}
      {revealed ? (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-4">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            {t('secretRevealed.title')}
          </p>
          <p className="text-xs text-amber-700/80 dark:text-amber-400/80">
            {t('secretRevealed.body')}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md bg-background px-3 py-2 font-mono text-xs">
              {revealed.secret}
            </code>
            <Button size="sm" variant="outline" onClick={() => onCopy(revealed.secret)}>
              {t('secretRevealed.copy')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRevealed(null)}>
              {t('secretRevealed.ack')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Endpoint list */}
      {endpoints.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {endpoints.map((ep) => (
            <li key={ep.id} className="space-y-2 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-sm">{ep.url}</code>
                    <span
                      className={
                        ep.disabledAt
                          ? 'rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground'
                          : 'rounded bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700'
                      }
                    >
                      {ep.disabledAt ? t('status.disabled') : t('status.active')}
                    </span>
                  </div>
                  {ep.description ? (
                    <p className="text-xs text-muted-foreground">{ep.description}</p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {ep.enabledEvents.length} {t('table.events')} ·{' '}
                    {format.dateTime(ep.createdAt, { dateStyle: 'short' })} ·{' '}
                    <code className="font-mono">whsec_…{ep.secretPrefix}</code>
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/settings/organization/webhooks/${ep.id}` as '/settings'}>
                      {t('actions.view')}
                    </Link>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => onRotate(ep.id)}
                  >
                    {pending ? t('actions.rotating') : t('actions.rotate')}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={pending}
                    onClick={() => onDelete(ep.id)}
                  >
                    {t('actions.delete')}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
