'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRouter } from '@/i18n/routing';

interface Credential {
  id: string;
  name: string;
  deviceType: string; // 'singleDevice' | 'multiDevice'
  backedUp: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
}

interface Props {
  credentials: Credential[];
}

/**
 * RFC 0007 PR-2 — 已注册的通行密钥列表，支持重命名和移除控件。
 * 服务器数据通过 RSC 父级（设置页面）流入。每个操作都调用 API +
 * router.refresh()，以便列表重新呈现，无需本地状态管道。
 */
export function PasskeyList({ credentials }: Props) {
  const t = useTranslations('account.passkeys');
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [pending, startTransition] = useTransition();

  if (credentials.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  }

  function handleRename(id: string) {
    if (!editName.trim()) {
      toast.error(t('errors.nameRequired'));
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/auth/webauthn/credentials/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: editName.trim() }),
      });
      if (!res.ok) {
        toast.error(t('errors.renameFailed'));
        return;
      }
      toast.success(t('renameSuccess'));
      setEditingId(null);
      setEditName('');
      router.refresh();
    });
  }

  function handleRemove(id: string, isLast: boolean) {
    const message = isLast ? t('removeConfirmLast') : t('removeConfirm');
    if (!window.confirm(message)) return;
    startTransition(async () => {
      const res = await fetch(`/api/auth/webauthn/credentials/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(t('errors.removeFailed'));
        return;
      }
      toast.success(t('removeSuccess'));
      router.refresh();
    });
  }

  return (
    <ul className="divide-y rounded-md border">
      {credentials.map((c, idx) => {
        const isLast = credentials.length === 1 && idx === 0;
        const editing = editingId === c.id;
        return (
          <li
            key={c.id}
            className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 space-y-1">
              {editing ? (
                <Input
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  maxLength={80}
                  className="max-w-sm"
                />
              ) : (
                <p className="font-medium">{c.name}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {c.deviceType === 'multiDevice' ? t('syncedDevices') : t('singleDevice')}
                {c.backedUp ? ` · ${t('backedUp')}` : null}
                {c.lastUsedAt
                  ? ` · ${t('lastUsed', { when: timeAgo(c.lastUsedAt) })}`
                  : ` · ${t('neverUsed')}`}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              {editing ? (
                <>
                  <Button size="sm" onClick={() => handleRename(c.id)} disabled={pending}>
                    {t('save')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingId(null);
                      setEditName('');
                    }}
                    disabled={pending}
                  >
                    {t('cancel')}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditingId(c.id);
                      setEditName(c.name);
                    }}
                    disabled={pending}
                  >
                    {t('rename')}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => handleRemove(c.id, isLast)}
                    disabled={pending}
                  >
                    {t('remove')}
                  </Button>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function timeAgo(d: Date): string {
  const ms = Date.now() - d.getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
