import { Button, Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

/**
 * 欢迎邮件的 Props 接口。
 * @property {string} [name="there"] - 收件人的显示名称
 * @property {string} [appUrl="https://kitora.dev"] - 应用基础 URL，用于仪表板链接
 */
interface WelcomeEmailProps {
  name?: string;
  appUrl?: string;
}

/**
 * 欢迎邮件模板。
 *
 * 在新用户注册并验证邮箱后立即发送。邮件欢迎用户加入 Kitora，
 * 并提供打开仪表板的直接链接以开始使用。
 *
 * @param {WelcomeEmailProps} props - 邮件参数
 * @returns {React.ReactElement} 欢迎邮件
 */
export default function WelcomeEmail({
  name = 'there',
  appUrl = 'https://kitora.dev',
}: WelcomeEmailProps) {
  return (
    <EmailLayout
      preview="Welcome to Kitora — let's get you started."
      heading={`Welcome aboard, ${name}`}
      footerNote="If you didn't create this account, you can safely ignore this email."
    >
      <Text className="text-base leading-6 text-zinc-700">
        We're excited to have you on Kitora. Your workspace is ready and you can start building
        right away.
      </Text>
      <Section className="mt-2">
        <Button
          href={`${appUrl}/dashboard`}
          className="rounded-md bg-zinc-900 px-5 py-3 text-sm font-medium text-white"
        >
          Open your dashboard
        </Button>
      </Section>
      <Text className="text-sm text-zinc-600">
        Need help? Reply to this email and we'll get back to you.
      </Text>
    </EmailLayout>
  );
}
