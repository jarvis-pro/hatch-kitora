'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { startAuthentication } from '@simplewebauthn/browser';

import {
  getPasskeyChallengeAction,
  verifyPasskeyForCurrentSessionAction,
} from '@/lib/account/passkeys';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/routing';

interface Props {
  callbackUrl: string;
}

/**
 * RFC 0007 PR-3 — 基于通行密钥的 2FA 挑战表单。
 *
 * 单个按钮：点击 → 服务器操作铸造挑战 → 浏览器
 * `startAuthentication()` → 服务器操作验证 + 翻转
 * tfa_pending。与 TOTP 表单的提交路径对称；唯一
 * 不同的是没有手动代码输入。
 */
export function TwoFactorPasskeyForm({ callbackUrl }: Props) {
  const t = useTranslations('auth.twoFactorChallenge.passkey');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      try {
        const challengeResult = await getPasskeyChallengeAction();
        if (!challengeResult.ok) {
          toast.error(t('errors.optionsFailed'));
          return;
        }

        const assertion = await startAuthentication({ optionsJSON: challengeResult.options });

        const verifyResult = await verifyPasskeyForCurrentSessionAction({ response: assertion });
        if (!verifyResult.ok) {
          toast.error(
            verifyResult.error === 'verification-failed' ||
              verifyResult.error === 'unknown-credential'
              ? t('errors.verifyFailed')
              : t('errors.generic'),
          );
          return;
        }

        router.replace(callbackUrl as '/dashboard');
        router.refresh();
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown';
        // 用户中止的仪式 → 软失败。
        if (msg.includes('NotAllowedError') || msg.includes('cancelled')) return;
        toast.error(t('errors.generic'));
      }
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <Button type="button" className="w-full" onClick={handleClick} disabled={pending}>
        {pending ? t('verifying') : t('cta')}
      </Button>
    </div>
  );
}
