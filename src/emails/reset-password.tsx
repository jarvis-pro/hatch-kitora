import { Button, Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

interface ResetPasswordEmailProps {
  resetUrl: string;
  name?: string;
}

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
