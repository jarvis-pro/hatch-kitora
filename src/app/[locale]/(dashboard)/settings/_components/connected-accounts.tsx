'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { unlinkProviderAction } from '@/services/account/actions';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/routing';

export interface ConnectedAccount {
  provider: string;
}

interface Props {
  /** All known providers configured for this app (by env). */
  available: readonly { id: string; label: string }[];
  /** Subset that's currently linked. */
  linked: ConnectedAccount[];
  /** Whether the user has a credentials password — affects last-method guard. */
  hasPassword: boolean;
}

export function ConnectedAccounts({ available, linked, hasPassword }: Props) {
  const t = useTranslations('account.connected');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (available.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('noProviders')}</p>;
  }

  const linkedSet = new Set(linked.map((l) => l.provider));
  const linkedCount = linked.length;

  const onUnlink = (provider: string) => {
    if (!confirm(t('confirmUnlink'))) return;
    startTransition(async () => {
      const result = await unlinkProviderAction({ provider });
      if (result.ok) {
        toast.success(t('unlinked'));
        router.refresh();
        return;
      }
      const map: Record<string, string> = {
        'last-login-method': t('errors.lastLoginMethod'),
        'not-linked': t('errors.notLinked'),
        'invalid-input': t('errors.invalidInput'),
        'not-found': t('errors.generic'),
      };
      toast.error(map[result.error] ?? t('errors.generic'));
    });
  };

  return (
    <ul className="divide-y rounded-md border">
      {available.map((p) => {
        const isLinked = linkedSet.has(p.id);
        // 当移除此行会导致没有登录方法时阻止取消链接。
        const wouldStrand = !hasPassword && linkedCount <= 1 && isLinked;
        return (
          <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="text-sm font-medium">{p.label}</p>
              <p className="text-xs text-muted-foreground">
                {isLinked ? t('statusLinked') : t('statusNotLinked')}
              </p>
            </div>
            {isLinked ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onUnlink(p.id)}
                disabled={pending || wouldStrand}
                title={wouldStrand ? t('errors.lastLoginMethod') : undefined}
              >
                {pending ? t('working') : t('unlink')}
              </Button>
            ) : (
              <Button asChild variant="outline" size="sm">
                {/* OAuth 登录 URL — Auth.js 处理重定向舞蹈。 */}
                <a href={`/api/auth/signin/${p.id}`}>{t('connect')}</a>
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
