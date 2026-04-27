import { Button, Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

/**
 * 数据导出就绪邮件的 Props 接口。
 * @property {string} [name="there"] - 收件人的显示名称
 * @property {string} [appUrl="https://kitora.dev"] - 应用基础 URL
 * @property {string} downloadUrl - 下载链接（绝对或相对）
 * @property {'USER' | 'ORG'} scope - 导出范围：个人数据或组织数据
 * @property {string} [expiresIn="in 7 days"] - 过期时间的显示文案（例如"7 天内"）
 */
interface Props {
  name?: string;
  appUrl?: string;
  downloadUrl: string;
  scope: 'USER' | 'ORG';
  expiresIn?: string;
}

/**
 * 数据导出就绪邮件模板。
 *
 * 在 cron 工作线程完成数据导出后发送（RFC 0002 PR-3）。
 * 下载链接受身份验证保护（收件人必须登录才能下载），
 * 文件在服务器端过期，因此即使 URL 本身不是单次使用，
 * 通过邮件发送也是安全的。
 *
 * @param {Props} props - 邮件参数
 * @returns {React.ReactElement} 数据导出就绪邮件
 */
export default function DataExportReadyEmail({
  name = 'there',
  appUrl = 'https://kitora.dev',
  downloadUrl,
  scope,
  expiresIn = 'in 7 days',
}: Props) {
  const subject = scope === 'ORG' ? 'organization data' : 'personal data';
  const downloadFullUrl = downloadUrl.startsWith('http') ? downloadUrl : `${appUrl}${downloadUrl}`;
  return (
    <EmailLayout
      preview={`Your ${subject} export is ready to download.`}
      heading="Your data export is ready"
      footerNote={`The download link expires ${expiresIn}. If you didn't request this export, please contact support.`}
    >
      <Text className="text-base leading-6 text-zinc-700">
        Hi {name}, your {subject} export has finished generating. You can grab the zip via the
        button below — you'll need to be signed in to your Kitora account.
      </Text>
      <Section className="mt-2">
        <Button
          href={downloadFullUrl}
          className="rounded-md bg-zinc-900 px-5 py-3 text-sm font-medium text-white"
        >
          Download export
        </Button>
      </Section>
      <Text className="text-sm text-zinc-600">
        The file contains a JSON-per-table breakdown plus a README with field descriptions.
        Sensitive credentials (password hash, API token hashes, 2FA secret) are intentionally
        omitted.
      </Text>
    </EmailLayout>
  );
}
