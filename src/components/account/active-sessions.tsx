'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { revokeDeviceSessionAction } from '@/services/account/sessions';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/routing';

export interface DeviceSessionRow {
  id: string;
  userAgent: string | null;
  ip: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  current: boolean;
}

interface Props {
  sessions: DeviceSessionRow[];
}

/**
 * 尽力将 UA 转换为人类可读标签。我们刻意避免引入 UA 解析库来处理一张卡片；
 * 下面的启发式方法覆盖了绝大多数真实流量（Chrome/Firefox/Safari/Edge 在
 * macOS/Windows/Linux/iOS/Android 上）。其他情况下回退到 i18n 中的 `unknownDevice`。
 */
function describeUserAgent(ua: string | null, fallback: string): string {
  if (!ua) return fallback;
  const lower = ua.toLowerCase();

  let os = '';
  if (lower.includes('iphone') || lower.includes('ipad')) os = 'iOS';
  else if (lower.includes('android')) os = 'Android';
  else if (lower.includes('mac os') || lower.includes('macintosh')) os = 'macOS';
  else if (lower.includes('windows')) os = 'Windows';
  else if (lower.includes('linux')) os = 'Linux';

  let browser = '';
  if (lower.includes('edg/')) browser = 'Edge';
  else if (lower.includes('chrome/') && !lower.includes('chromium')) browser = 'Chrome';
  else if (lower.includes('firefox/')) browser = 'Firefox';
  else if (lower.includes('safari/') && !lower.includes('chrome')) browser = 'Safari';

  const parts = [browser, os].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : fallback;
}

export function ActiveSessions({ sessions }: Props) {
  const t = useTranslations('account.sessions');
  const format = useFormatter();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const others = sessions.filter((s) => !s.current);
  const current = sessions.find((s) => s.current);

  const onRevoke = (id: string) => {
    if (!confirm(t('revokeConfirm'))) return;
    startTransition(async () => {
      const result = await revokeDeviceSessionAction({ id });
      if (result.ok) {
        toast.success(t('revoked'));
        router.refresh();
        return;
      }
      toast.error(
        result.error === 'cannot-revoke-current'
          ? t('errors.cannotRevokeCurrent')
          : t('errors.revoke'),
      );
    });
  };

  return (
    <div className="space-y-4">
      {current ? <SessionRow session={current} canRevoke={false} pending={false} /> : null}

      {others.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {others.map((s) => (
            <li key={s.id}>
              <SessionRow session={s} canRevoke pending={pending} onRevoke={() => onRevoke(s.id)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  function SessionRow({
    session,
    canRevoke,
    pending,
    onRevoke,
  }: {
    session: DeviceSessionRow;
    canRevoke: boolean;
    pending: boolean;
    onRevoke?: () => void;
  }) {
    const label = describeUserAgent(session.userAgent, t('unknownDevice'));
    return (
      <div className="flex items-center justify-between rounded-md border p-3">
        <div className="space-y-1 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium">{label}</span>
            {session.current ? (
              <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {t('currentBadge')}
              </span>
            ) : null}
          </div>
          <div className="text-xs text-muted-foreground">
            {t('lastSeen', {
              date: format.relativeTime(session.lastSeenAt),
            })}
            {session.ip ? <> · {t('ipLabel', { ip: session.ip })}</> : null}
          </div>
          <div className="text-xs text-muted-foreground">
            {t('createdAt', {
              date: format.dateTime(session.createdAt, { dateStyle: 'medium' }),
            })}
          </div>
        </div>
        {canRevoke ? (
          <Button variant="outline" size="sm" disabled={pending} onClick={onRevoke}>
            {pending ? t('revoking') : t('revoke')}
          </Button>
        ) : null}
      </div>
    );
  }
}
