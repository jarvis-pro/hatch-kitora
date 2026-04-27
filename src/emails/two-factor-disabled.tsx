import { Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

/**
 * 双因素认证禁用邮件的 Props 接口。
 * @property {string} [name="there"] - 收件人的显示名称
 * @property {string} [appUrl="https://kitora.dev"] - 应用基础 URL
 * @property {boolean} [byAdmin=false] - 是否由平台管理员禁用（账户恢复流程）
 */
interface Props {
  name?: string;
  appUrl?: string;
  byAdmin?: boolean;
}

/**
 * 双因素认证禁用邮件模板。
 *
 * 在 2FA 从账户移除时发送（无论用户自行禁用还是平台管理员在恢复流程中禁用）
 * （RFC 0002 PR-2）。这是一封安全警报邮件，而非礼貌通知。
 *
 * @param {Props} props - 邮件参数
 * @returns {React.ReactElement} 双因素认证禁用邮件
 */
export default function TwoFactorDisabledEmail({
  name = 'there',
  appUrl = 'https://kitora.dev',
  byAdmin = false,
}: Props) {
  return (
    <EmailLayout
      preview="Two-factor authentication is no longer protecting your Kitora account."
      heading="Two-factor authentication disabled"
      footerNote="If this wasn't you, sign in immediately and re-enable 2FA from Settings → Security, then review your active sessions."
    >
      <Text className="text-base leading-6 text-zinc-700">
        Hi {name}, two-factor authentication has just been{' '}
        {byAdmin ? 'reset by a Kitora administrator' : 'turned off on your Kitora account'}. Your
        password alone is now enough to sign in.
      </Text>
      <Section className="mt-2">
        <Text className="text-sm text-zinc-600">
          We strongly recommend turning 2FA back on at{' '}
          <a href={`${appUrl}/settings`} className="text-zinc-900 underline">
            Settings → Security
          </a>{' '}
          unless you're sure you no longer need the extra protection.
        </Text>
      </Section>
    </EmailLayout>
  );
}
