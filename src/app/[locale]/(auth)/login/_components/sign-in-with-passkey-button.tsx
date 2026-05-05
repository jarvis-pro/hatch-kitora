'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';

import { Button } from '@/components/ui/button';

interface Props {
  /** 可选回调 URL（通常来自 /login 的 `?callbackUrl=`）。 */
  callbackUrl?: string;
}

/**
 * RFC 0007 PR-4 — /login 上的 "使用通行密钥登录" 按钮。
 *
 * 可发现 / 无用户名流：
 *   1. POST /api/auth/webauthn/authenticate/options (匿名)
 *      — 服务器在 httpOnly cookie 中隐藏挑战，返回选项
 *        具有 `allowCredentials: []`。
 *   2. 通过 SimpleWebAuthn 的 `navigator.credentials.get()` — 浏览器打开
 *      OS / 密码管理器选择器。
 *   3. POST /api/auth/webauthn/authenticate/verify 和声称 —
 *      服务器反向查找凭证，铸造会话 cookie，
 *      响应 `{ redirectTo }`。
 *   4. 浏览器导航到 `redirectTo` — 中间件立即尊重新鲜
 *      cookie。
 *
 * 当浏览器不支持 WebAuthn 时隐藏该按钮（RFC
 * 0007 §1 "降级先于扩展"）。在用户取消时软失败。
 */
export function SignInWithPasskeyButton({ callbackUrl }: Props) {
  const t = useTranslations('auth.login.passkey');
  const [supported, setSupported] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
  }, []);

  if (!supported) return null;

  function handleClick() {
    startTransition(async () => {
      try {
        const optionsRes = await fetch('/api/auth/webauthn/authenticate/options', {
          method: 'POST',
        });
        if (!optionsRes.ok) {
          toast.error(t('errors.optionsFailed'));
          return;
        }
        const options = await optionsRes.json();

        const assertion = await startAuthentication({ optionsJSON: options });

        const verifyRes = await fetch('/api/auth/webauthn/authenticate/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ response: assertion, callbackUrl }),
        });
        const result = (await verifyRes.json()) as {
          ok?: boolean;
          redirectTo?: string;
          error?: string;
        };
        if (!verifyRes.ok || !result.ok) {
          toast.error(t('errors.verifyFailed'));
          return;
        }

        // 硬导航以便中间件在下一个请求时看到新设置的 cookie。
        // router.replace 会跳过 cookie 往返。
        window.location.assign(result.redirectTo ?? '/dashboard');
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown';
        // 用户中止的仪式抛出 NotAllowedError — 软失败，
        // 用户显然选择了不进行身份验证。
        if (msg.includes('NotAllowedError') || msg.includes('cancelled')) return;
        toast.error(t('errors.generic'));
      }
    });
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      onClick={handleClick}
      disabled={pending}
    >
      {pending ? t('verifying') : t('cta')}
    </Button>
  );
}
