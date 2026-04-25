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

interface WelcomeEmailProps {
  name?: string;
  appUrl?: string;
}

export default function WelcomeEmail({
  name = 'there',
  appUrl = 'https://kitora.dev',
}: WelcomeEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Welcome to Kitora — let's get you started.</Preview>
      <Tailwind>
        <Body className="bg-white font-sans">
          <Container className="mx-auto max-w-xl px-6 py-10">
            <Heading className="text-2xl font-bold text-zinc-900">
              Welcome aboard, {name} 👋
            </Heading>
            <Text className="text-base leading-6 text-zinc-700">
              We're excited to have you on Kitora. Your workspace is ready and you can start
              building right away.
            </Text>
            <Section className="mt-6">
              <Button
                href={`${appUrl}/dashboard`}
                className="rounded-md bg-zinc-900 px-5 py-3 text-sm font-medium text-white"
              >
                Open your dashboard
              </Button>
            </Section>
            <Hr className="my-8 border-zinc-200" />
            <Text className="text-xs text-zinc-500">
              If you didn't create this account, you can safely ignore this email.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
