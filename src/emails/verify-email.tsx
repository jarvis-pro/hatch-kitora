import { Button, Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

interface VerifyEmailProps {
  verifyUrl: string;
  name?: string;
}

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
