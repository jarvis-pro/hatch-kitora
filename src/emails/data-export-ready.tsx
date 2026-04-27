import { Button, Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

interface Props {
  name?: string;
  appUrl?: string;
  downloadUrl: string;
  scope: 'USER' | 'ORG';
  /** 存储过期副本的显示 — 例如 "在 7 天内"。 */
  expiresIn?: string;
}

/**
 * RFC 0002 PR-3 — 当数据导出完成时由 cron 工作线程发送。
 * 链接受身份验证保护（收件人必须登录才能下载）
 * 和文件在服务器端过期，所以即使 URL 本身不是单次使用，
 * 这也可以安全地通过电子邮件发送。
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
