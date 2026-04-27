import { Button, Section, Text } from '@react-email/components';
import { OrgRole } from '@prisma/client';

import { EmailLayout } from './_layout';

/**
 * 组织邀请邮件的 Props 接口。
 * @property {string} [orgName="an organization"] - 组织名称
 * @property {string} [inviterName] - 邀请方的名称（未提供时显示"A team admin"）
 * @property {OrgRole} [role=OrgRole.MEMBER] - 受邀者的角色（ADMIN 或 MEMBER）
 * @property {string} [acceptUrl="https://kitora.dev"] - 接受邀请的链接
 */
interface Props {
  orgName?: string;
  inviterName?: string;
  role?: OrgRole;
  acceptUrl?: string;
}

/**
 * 组织邀请邮件模板。
 *
 * 在用户被邀请加入组织时发送。邮件包含邀请方、组织和角色信息，
 * 以及接受邀请的按钮链接。
 *
 * @param {Props} props - 邮件参数
 * @returns {React.ReactElement} 组织邀请邮件
 */
export default function OrgInvitationEmail({
  orgName = 'an organization',
  inviterName,
  role = OrgRole.MEMBER,
  acceptUrl = 'https://kitora.dev',
}: Props) {
  // 如果未提供邀请方名称，使用默认的"A team admin"
  const inviter = inviterName ?? 'A team admin';
  // 根据角色生成对应的标签显示文案
  const roleLabel = role === OrgRole.ADMIN ? 'admin' : 'member';

  return (
    <EmailLayout
      preview={`${inviter} invited you to ${orgName} on Kitora`}
      heading={`You're invited to ${orgName}`}
      footerNote="If you didn't expect this invitation, you can safely ignore this email — the link expires automatically in 7 days."
    >
      <Text className="text-base leading-6 text-zinc-700">
        {inviter} has invited you to join <strong>{orgName}</strong> on Kitora as a {roleLabel}.
      </Text>
      <Section className="mt-2">
        <Button
          href={acceptUrl}
          className="rounded-md bg-zinc-900 px-5 py-3 text-sm font-medium text-white"
        >
          Accept invitation
        </Button>
      </Section>
      <Text className="text-sm text-zinc-600">
        This link expires in 7 days. You'll need to sign in (or create an account) using this email
        address to accept.
      </Text>
    </EmailLayout>
  );
}
