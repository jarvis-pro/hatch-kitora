import {
  Body,
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

interface EmailLayoutProps {
  preview: string;
  heading: string;
  children: React.ReactNode;
  /** Footer note above the legal line — typically a "if you didn't … ignore" disclaimer. */
  footerNote?: string;
  /** Brand name shown in the masthead and footer. */
  brand?: string;
}

/**
 * Shared chrome for every transactional email — masthead, container width,
 * footer disclaimer + brand line. Individual templates only need to drop in
 * their preview, heading and body content.
 */
export function EmailLayout({
  preview,
  heading,
  children,
  footerNote,
  brand = 'Kitora',
}: EmailLayoutProps) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind>
        <Body className="bg-zinc-50 font-sans">
          <Container className="mx-auto max-w-xl px-6 py-10">
            <Section>
              <Text className="m-0 text-sm font-semibold tracking-tight text-zinc-900">
                {brand}
              </Text>
            </Section>
            <Section className="mt-6 rounded-xl border border-zinc-200 bg-white px-8 py-10">
              <Heading className="m-0 text-2xl font-bold tracking-tight text-zinc-900">
                {heading}
              </Heading>
              <div className="mt-4 space-y-4">{children}</div>
            </Section>
            <Hr className="my-6 border-zinc-200" />
            {footerNote ? <Text className="m-0 text-xs text-zinc-500">{footerNote}</Text> : null}
            <Text className="mt-4 text-xs text-zinc-400">
              © {new Date().getFullYear()} {brand}.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
