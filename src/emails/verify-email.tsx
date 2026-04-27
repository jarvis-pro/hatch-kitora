import { Button, Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

/**
 * 邮箱验证邮件的 Props 接口。
 * @property {string} verifyUrl - 邮箱验证链接（通常包含一次性 token）
 * @property {string} [name="there"] - 收件人的显示名称
 */
interface VerifyEmailProps {
  verifyUrl: string;
  name?: string;
}

/**
 * 邮箱验证邮件模板。
 *
 * 在用户新注册账户后立即发送。邮件包含验证邮箱地址的按钮链接，
 * 默认链接有效期为 24 小时。
 *
 * @param {VerifyEmailProps} props - 邮件参数
 * @returns {React.ReactElement} 邮箱验证邮件
 */
export default function VerifyEmail({ verifyUrl, name = 'there' }: VerifyEmailProps) {
  return (
    <EmailLayout
      preview="Verify your Kitora email address"
      heading="Verify your email"
      footerNote="If you didn't sign up, you can safely ignore this email."
    >
      <Text className="text-base leading-6 text-zinc-700">
        Hi {name}, please confirm your email address to finish setting up your Kitora account.
      </Text>
      <Section className="mt-2">
        <Button
          href={verifyUrl}
          className="rounded-md bg-zinc-900 px-5 py-3 text-sm font-medium text-white"
        >
          Verify email
        </Button>
      </Section>
      <Text className="text-sm text-zinc-500">
        This link expires in 24 hours. If it has, you can request a fresh one from the verify page.
      </Text>
    </EmailLayout>
  );
}
