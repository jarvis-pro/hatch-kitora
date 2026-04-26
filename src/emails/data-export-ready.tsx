import { Button, Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

interface Props {
  name?: string;
  appUrl?: string;
  downloadUrl: string;
  scope: 'USER' | 'ORG';
  /** Display copy of the storage expiry — e.g. "in 7 days". */
  expiresIn?: string;
}

/**
 * RFC 0002 PR-3 — sent by the cron worker when a data export finishes.
 * The link is auth-gated (the recipient must be signed in to download)
 * and the file expires server-side, so this is safe to email even though
 * the URL itself isn't single-use.
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
