'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { loginAction } from '@/lib/auth/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from '@/i18n/routing';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

type Values = z.infer<typeof schema>;

/**
 * RFC 0004 PR-2 — 具有三种模式的登录表单：
 *
 *   - `password`  (默认) — 电子邮件 + 密码字段。
 *   - `sso-only`  — 仅电子邮件字段；提交 POST 到
 *                    `/api/auth/sso/start`。当用户的电子邮件
 *                    域匹配具有 `enforceForLogin = true` 的组织时触发，
 *                    或当他们明确点击 "使用 SSO 继续" 时。
 *   - `sso-suggested` — 与 `sso-only` 相同形状，但有一个后退箭头
 *                       恢复密码字段。手动触发。
 *
 * `sso_error` 查询参数（由 /api/auth/sso/start + /callback 设置）
 * 显示为内联警报。代码通过 `auth.login.sso.errors.*` i18n 表映射到友好字符串。
 */
export function LoginForm() {
  const t = useTranslations('auth.login');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [mode, setMode] = useState<'password' | 'sso-suggested' | 'sso-only'>('password');
  const [ssoEmail, setSsoEmail] = useState('');
  const [ssoErrorBanner, setSsoErrorBanner] = useState<string | null>(null);

  // 从 /start 或 /callback 拾取 `?sso_error=...`。URLSearchParams 在
  // `'use client'` 中是安全的；我们在 SSR 期间不依赖它。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('sso_error');
    if (code) setSsoErrorBanner(code);
  }, []);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = (values: Values) => {
    startTransition(async () => {
      const result = await loginAction(values);
      if (result.ok) {
        router.replace('/dashboard');
        router.refresh();
        return;
      }
      // RFC 0004 PR-2 — 用户的组织已打开 `enforceForLogin`。
      // 将表单切换为仅 SSO，以电子邮件预填而不是
      // 显示通用 "凭证无效" 提示。
      if (result.error === 'sso-required') {
        setSsoEmail(result.email ?? values.email);
        setMode('sso-only');
        return;
      }
      toast.error(t('errors.invalid'));
    });
  };

  const ssoErrorText = ssoErrorBanner ? mapSsoError(t, ssoErrorBanner) : null;

  return (
    <div className="space-y-4">
      {ssoErrorText ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {ssoErrorText}
        </div>
      ) : null}

      {mode === 'password' ? (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{t('fields.email')}</Label>
            <Input id="email" type="email" autoComplete="email" {...register('email')} />
            {errors.email ? (
              <p className="text-xs text-destructive">{errors.email.message}</p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t('fields.password')}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              {...register('password')}
            />
            {errors.password ? (
              <p className="text-xs text-destructive">{errors.password.message}</p>
            ) : null}
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? t('submitting') : t('submit')}
          </Button>

          <div className="relative my-2">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">{t('sso.divider')}</span>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={pending}
            onClick={() => setMode('sso-suggested')}
          >
            {t('sso.continueButton')}
          </Button>
        </form>
      ) : (
        <SsoEmailRail
          email={ssoEmail}
          locked={mode === 'sso-only'}
          onBack={mode === 'sso-suggested' ? () => setMode('password') : null}
          lockedNotice={mode === 'sso-only' ? t('sso.lockedNotice') : null}
        />
      )}
    </div>
  );
}

/**
 * SSO 专用轨道。提交本地表单 POST 到 `/api/auth/sso/start`
 * （而不是 fetch）以便响应上设置的 cookie 实际上下载 —
 * 以 IdP 结尾的重定向链需要 cookie 附加到
 * 预重定向导航。
 */
function SsoEmailRail({
  email,
  locked,
  onBack,
  lockedNotice,
}: {
  email: string;
  /** 当表单显示是因为组织强制 SSO 时为真。禁用电子邮件字段。 */
  locked: boolean;
  /** 当用户可以切换回密码模式时提供。 */
  onBack: (() => void) | null;
  lockedNotice: string | null;
}) {
  const t = useTranslations('auth.login');
  return (
    <form
      method="POST"
      action="/api/auth/sso/start"
      className="space-y-4"
      // 将电子邮件值显示为默认值 — 锁定时只读。
      key={email /* 在锁定翻转时重新渲染输入 */}
    >
      {lockedNotice ? (
        <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-sm text-blue-700 dark:text-blue-400">
          {lockedNotice}
        </div>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="sso-email">{t('fields.email')}</Label>
        <Input
          id="sso-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          defaultValue={email}
          readOnly={locked}
        />
      </div>
      <Button type="submit" className="w-full">
        {t('sso.continueButton')}
      </Button>
      {onBack ? (
        <Button type="button" variant="ghost" className="w-full" onClick={onBack}>
          {t('sso.back')}
        </Button>
      ) : null}
    </form>
  );
}

function mapSsoError(t: ReturnType<typeof useTranslations>, code: string): string {
  // 将 `invalid-domain:reason` 归一化为通用 invalid-domain 存储桶
  // — 用户不需要在这里看到验证器的内部原因。
  const head = code.split(':')[0] ?? code;
  const knownKeys = new Set([
    'email-required',
    'bad-email',
    'no-idp',
    'authorize-failed',
    'invalid-input',
    'state-mismatch',
    'missing-code',
    'idp-rejected',
    'token-exchange-failed',
    'token-missing',
    'userinfo-failed',
    'userinfo-incomplete',
    'idp-not-found',
    'jit-failed',
    'user-gone',
    'acs-bad-form',
    'acs-no-response',
    'acs-validation-failed',
    'acs-no-redirect',
    'invalid-domain',
  ]);
  const key = knownKeys.has(head) ? head : 'generic';
  return t(`sso.errors.${key.replace(/-/g, '_')}`);
}
