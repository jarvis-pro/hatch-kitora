'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { createApiTokenAction, revokeApiTokenAction } from '@/lib/account/api-tokens';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';

/**
 * API 令牌行数据结构
 */
export interface ApiTokenRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/**
 * ApiTokens 组件 Props
 * @property {ApiTokenRow[]} tokens - API 令牌列表
 */
interface Props {
  tokens: ApiTokenRow[];
}

/**
 * 格式化日期为 YYYY-MM-DD 格式
 * @param d - 要格式化的日期，null 时返回连字符
 * @returns 格式化后的日期字符串
 */
function formatDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : '—';
}

/**
 * API 令牌管理组件
 * 用于创建、查看和撤销 API 令牌。支持一次性显示新创建的令牌原文（之后无法查看），
 * 提供复制到剪贴板功能，可撤销或删除过期令牌。
 * @param {Props} props
 * @returns 令牌管理界面
 */
export function ApiTokens({ tokens }: Props) {
  const t = useTranslations('account.apiTokens');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [revealed, setRevealed] = useState<{ raw: string; name: string } | null>(null);

  /**
   * 创建新 API 令牌
   */
  const onCreate = () => {
    if (!name.trim()) return;
    startTransition(async () => {
      // 调用服务端 action 创建令牌
      const result = await createApiTokenAction({ name: name.trim() });
      if (!result.ok) {
        toast.error(t('errors.create'));
        return;
      }
      // 一次性显示新令牌的原文
      setRevealed({ raw: result.token.raw, name: result.token.name });
      setName('');
      router.refresh();
    });
  };

  /**
   * 撤销指定 API 令牌
   * @param tokenId - 令牌 ID
   */
  const onRevoke = (tokenId: string) => {
    if (!confirm(t('confirmRevoke'))) return;
    startTransition(async () => {
      // 调用服务端 action 撤销令牌
      const result = await revokeApiTokenAction({ tokenId });
      if (result.ok) {
        toast.success(t('revoked'));
        router.refresh();
      } else {
        toast.error(t('errors.revoke'));
      }
    });
  };

  /**
   * 复制令牌到剪贴板
   * @param raw - 要复制的令牌原文
   */
  const onCopy = async (raw: string) => {
    try {
      await navigator.clipboard.writeText(raw);
      toast.success(t('copied'));
    } catch {
      toast.error(t('errors.copy'));
    }
  };

  return (
    <div className="space-y-6">
      {/* 创建令牌表单 */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-2">
          <Label htmlFor="token-name">{t('createLabel')}</Label>
          <Input
            id="token-name"
            placeholder={t('createPlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
        </div>
        <Button onClick={onCreate} disabled={pending || !name.trim()}>
          {pending ? t('creating') : t('create')}
        </Button>
      </div>

      {/* 一次性显示新创建令牌的原文 */}
      {revealed ? (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-4">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            {t('revealedTitle', { name: revealed.name })}
          </p>
          <p className="text-xs text-amber-700/80 dark:text-amber-400/80">{t('revealedHint')}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md bg-background px-3 py-2 font-mono text-xs">
              {revealed.raw}
            </code>
            <Button size="sm" variant="outline" onClick={() => onCopy(revealed.raw)}>
              {t('copy')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRevealed(null)}>
              {t('dismiss')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* 令牌列表 */}
      {tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {tokens.map((token) => {
            // 判断令牌是否已被撤销或已过期
            const revoked = !!token.revokedAt;
            const expired = !!token.expiresAt && token.expiresAt.getTime() < Date.now();
            return (
              <li key={token.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{token.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {token.prefix}…
                    <span className="ml-2 inline-block">
                      {t('lastUsed', { date: formatDate(token.lastUsedAt) })}
                    </span>
                    <span className="ml-2 inline-block">
                      {t('created', { date: formatDate(token.createdAt) })}
                    </span>
                    {token.expiresAt ? (
                      <span className="ml-2 inline-block">
                        {t('expires', { date: formatDate(token.expiresAt) })}
                      </span>
                    ) : null}
                  </p>
                </div>
                {revoked ? (
                  <span className="text-xs text-muted-foreground">{t('revokedTag')}</span>
                ) : expired ? (
                  <span className="text-xs text-muted-foreground">{t('expiredTag')}</span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onRevoke(token.id)}
                    disabled={pending}
                  >
                    {t('revoke')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
