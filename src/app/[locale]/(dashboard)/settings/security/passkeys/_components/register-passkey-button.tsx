'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { startRegistration } from '@simplewebauthn/browser';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';

/**
 * RFC 0007 PR-2 — `/settings/security/passkeys` 页面上的 "添加通行密钥" CTA。
 *
 * 两阶段 UI：
 *   1. 点击 "添加通行密钥" → 显示名称输入框 + 确认。
 *   2. 提交名称 → POST /options → startRegistration() → POST /verify
 *      → router.refresh()，使 RSC 列表获取新行。
 *
 * 此处没有二维码 / 设备选择器 UI — OS / 浏览器拥有该步骤。
 */
export function RegisterPasskeyButton() {
  const t = useTranslations('account.passkeys');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [pending, startTransition] = useTransition();

  function handleAdd() {
    if (!name.trim()) {
      toast.error(t('errors.nameRequired'));
      return;
    }
    startTransition(async () => {
      try {
        const optionsRes = await fetch('/api/auth/webauthn/register/options', { method: 'POST' });
        if (!optionsRes.ok) {
          toast.error(t('errors.optionsFailed'));
          return;
        }
        const options = await optionsRes.json();

        // 浏览器仪式 — 用户触摸传感器 / 插入密钥。
        const attestation = await startRegistration({ optionsJSON: options });

        const verifyRes = await fetch('/api/auth/webauthn/register/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ response: attestation, name: name.trim() }),
        });
        const result = (await verifyRes.json()) as { ok?: boolean; error?: string };
        if (!verifyRes.ok || !result.ok) {
          toast.error(t('errors.verifyFailed'));
          return;
        }

        toast.success(t('addSuccess'));
        setOpen(false);
        setName('');
        router.refresh();
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown';
        // 用户中止的仪式抛出 `NotAllowedError` — 软失败。
        if (msg.includes('NotAllowedError') || msg.includes('cancelled')) return;
        toast.error(t('errors.unknown'));
      }
    });
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} variant="default">
        {t('addCta')}
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-4">
      <Label htmlFor="passkey-name">{t('nameLabel')}</Label>
      <Input
        id="passkey-name"
        autoFocus
        placeholder={t('namePlaceholder')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={80}
      />
      <div className="flex gap-2">
        <Button onClick={handleAdd} disabled={pending}>
          {pending ? t('adding') : t('confirmAdd')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setName('');
          }}
          disabled={pending}
        >
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}
