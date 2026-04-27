import { Button, Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

/**
 * 账户删除计划邮件的 Props 接口。
 * @property {string} [name="there"] - 收件人的显示名称
 * @property {string} [appUrl="https://kitora.dev"] - 应用基础 URL，用于取消删除链接
 * @property {string} scheduledFor - 预格式化的删除日期（调用方负责本地化格式）
 */
interface Props {
  name?: string;
  appUrl?: string;
  scheduledFor: string;
}

/**
 * 账户删除计划邮件模板。
 *
 * 在用户请求账户删除时发送（RFC 0002 PR-4）。作为防误触机制：
 * 如果收件人未主动计划删除，可在 `scheduledFor` 日期前登录并取消。
 *
 * @param {Props} props - 邮件参数
 * @returns {React.ReactElement} 账户删除计划邮件
 */
export default function AccountDeletionScheduledEmail({
  name = 'there',
  appUrl = 'https://kitora.dev',
  scheduledFor,
}: Props) {
  return (
    <EmailLayout
      preview={`Your Kitora account is scheduled for deletion on ${scheduledFor}.`}
      heading="Your account is scheduled for deletion"
      footerNote="If you didn't request this, sign in and cancel deletion immediately, then change your password and review active sessions."
    >
      <Text className="text-base leading-6 text-zinc-700">
        Hi {name}, your Kitora account will be permanently deleted on{' '}
        <strong>{scheduledFor}</strong>. Until then you can sign in and cancel the deletion at any
        time. After that date, all your data — profile, organizations you own as the only member,
        API tokens, audit history visibility — is irrecoverable.
      </Text>
      <Section className="mt-2">
        <Button
          href={`${appUrl}/settings`}
          className="rounded-md bg-zinc-900 px-5 py-3 text-sm font-medium text-white"
        >
          Cancel deletion
        </Button>
      </Section>
    </EmailLayout>
  );
}
