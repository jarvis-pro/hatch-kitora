import { Button, Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

/**
 * 密码重置邮件的 Props 接口。
 * @property {string} resetUrl - 密码重置链接（通常包含一次性 token）
 * @property {string} [name="there"] - 收件人的显示名称
 */
interface ResetPasswordEmailProps {
  resetUrl: string;
  name?: string;
}

/**
 * 密码重置邮件模板。
 *
 * 在用户请求密码重置时发送。邮件包含重置密码的按钮链接，
 * 默认链接有效期为 30 分钟。
 *
 * @param {ResetPasswordEmailProps} props - 邮件参数
 * @returns {React.ReactElement} 密码重置邮件
 */
export default function ResetPasswordEmail({ resetUrl, name = 'there' }: ResetPasswordEmailProps) {
  return (
    <EmailLayout
      preview="Reset your Kitora password"
      heading="Reset your password"
      footerNote="If you didn't request this, you can safely ignore this email — your password remains unchanged."
    >
      <Text className="text-base leading-6 text-zinc-700">
        Hi {name}, we received a request to reset your password. Click the button below to choose a
        new one. This link will expire in 30 minutes.
      </Text>
      <Section className="mt-2">
        <Button
          href={resetUrl}
          className="rounded-md bg-zinc-900 px-5 py-3 text-sm font-medium text-white"
        >
          Reset password
        </Button>
      </Section>
    </EmailLayout>
  );
}
