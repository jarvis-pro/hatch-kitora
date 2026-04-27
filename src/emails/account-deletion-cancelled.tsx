import { Text } from '@react-email/components';

import { EmailLayout } from './_layout';

/**
 * 账户删除取消邮件的 Props 接口。
 * @property {string} [name="there"] - 收件人的显示名称
 */
interface Props {
  name?: string;
}

/**
 * 账户删除取消确认邮件模板。
 *
 * 在用户取消已计划的账户删除时发送（RFC 0002 PR-4）。
 * 邮件故意设计得简短，因为在应用内 UI 已确认取消，
 * 本邮件仅作为审计日志发送到收件箱。
 *
 * @param {Props} props - 邮件参数
 * @returns {React.ReactElement} 账户删除取消邮件
 */
export default function AccountDeletionCancelledEmail({ name = 'there' }: Props) {
  return (
    <EmailLayout
      preview="Your Kitora account deletion has been cancelled."
      heading="Account deletion cancelled"
    >
      <Text className="text-base leading-6 text-zinc-700">
        Hi {name}, the scheduled deletion of your Kitora account has been cancelled. Your account is
        back to its normal state.
      </Text>
    </EmailLayout>
  );
}
