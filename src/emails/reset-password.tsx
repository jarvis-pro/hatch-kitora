import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Tailwind,
  Text,
} from '@react-email/components';

interface ResetPasswordEmailProps {
  resetUrl: string;
  name?: string;
}

export default function ResetPasswordEmail({
  resetUrl,
  name = 'there',
}: ResetPasswordEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Reset your Kitora password</Preview>
      <Tailwind>
        <Body className="bg-white font-sans">
          <Container className="mx-auto max-w-xl px-6 py-10">
            <Heading className="text-2xl font-bold text-zinc-900">Reset your password</Heading>
            <Text className="text-base leading-6 text-zinc-700">
              Hi {name}, we received a request to reset your password. Click the button below to
              choose a new one. This link will expire in 30 minutes.
            </Text>
            <Section className="mt-6">
              <Button
                href={resetUrl}
                className="rounded-md bg-zinc-900 px-5 py-3 text-sm font-medium text-white"
              >
                Reset password
              </Button>
            </Section>
            <Hr className="my-8 border-zinc-200" />
            <Text className="text-xs text-zinc-500">
              If you didn't request this, you can safely ignore this email.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
