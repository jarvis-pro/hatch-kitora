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

interface VerifyEmailProps {
  verifyUrl: string;
  name?: string;
}

export default function VerifyEmail({ verifyUrl, name = 'there' }: VerifyEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Verify your Kitora email address</Preview>
      <Tailwind>
        <Body className="bg-white font-sans">
          <Container className="mx-auto max-w-xl px-6 py-10">
            <Heading className="text-2xl font-bold text-zinc-900">Verify your email</Heading>
            <Text className="text-base leading-6 text-zinc-700">
              Hi {name}, please confirm your email address to finish setting up your Kitora account.
            </Text>
            <Section className="mt-6">
              <Button
                href={verifyUrl}
                className="rounded-md bg-zinc-900 px-5 py-3 text-sm font-medium text-white"
              >
                Verify email
              </Button>
            </Section>
            <Hr className="my-8 border-zinc-200" />
            <Text className="text-xs text-zinc-500">
              If you didn't sign up, you can safely ignore this email.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
