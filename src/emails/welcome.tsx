import { Button, Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

interface WelcomeEmailProps {
  name?: string;
  appUrl?: string;
}

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
