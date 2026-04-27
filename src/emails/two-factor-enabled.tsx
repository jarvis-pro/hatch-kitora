import { Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

interface Props {
  name?: string;
  appUrl?: string;
}

/**
 * RFC 0002 PR-2 — 在成功 2FA 注册确认后立即发送。
 * 此电子邮件的重点不是庆祝；而是如果 *其他人* 刚刚打开 2FA，
 * 则警告账户所有者（例如，会话被劫持）。如果
 * 收件人没有启用 2FA，他们应该登录并禁用它。
 */
export default function TwoFactorEnabledEmail({
  name = 'there',
  appUrl = 'https://kitora.dev',
}: Props) {
  return (
    <EmailLayout
      preview="Two-factor authentication is now on for your Kitora account."
      heading="Two-factor authentication enabled"
      footerNote="If this wasn't you, sign in and disable 2FA from Settings → Security immediately, then change your password."
    >
      <Text className="text-base leading-6 text-zinc-700">
        Hi {name}, two-factor authentication has just been turned on for your Kitora account. From
        now on you'll be asked for a 6-digit code from your authenticator app every time you sign
        in.
      </Text>
      <Section className="mt-2">
        <Text className="text-sm text-zinc-600">
          Keep your backup codes somewhere safe — they're the only way back in if you lose access to
          your authenticator. You can review or regenerate them at{' '}
          <a href={`${appUrl}/settings`} className="text-zinc-900 underline">
            Settings → Security
          </a>
          .
        </Text>
      </Section>
    </EmailLayout>
  );
}
