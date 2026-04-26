import { Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

interface Props {
  name?: string;
  appUrl?: string;
  /** True when the disable was performed by a platform admin (account recovery). */
  byAdmin?: boolean;
}

/**
 * RFC 0002 PR-2 — sent whenever 2FA is removed from the account, whether by
 * the user themselves or by a platform admin during a recovery flow. As with
 * the enable email this is a security alert, not a polite notice.
 */
export default function TwoFactorDisabledEmail({
  name = 'there',
  appUrl = 'https://kitora.dev',
  byAdmin = false,
}: Props) {
  return (
    <EmailLayout
      preview="Two-factor authentication is no longer protecting your Kitora account."
      heading="Two-factor authentication disabled"
      footerNote="If this wasn't you, sign in immediately and re-enable 2FA from Settings → Security, then review your active sessions."
    >
      <Text className="text-base leading-6 text-zinc-700">
        Hi {name}, two-factor authentication has just been{' '}
        {byAdmin ? 'reset by a Kitora administrator' : 'turned off on your Kitora account'}. Your
        password alone is now enough to sign in.
      </Text>
      <Section className="mt-2">
        <Text className="text-sm text-zinc-600">
          We strongly recommend turning 2FA back on at{' '}
          <a href={`${appUrl}/settings`} className="text-zinc-900 underline">
            Settings → Security
          </a>{' '}
          unless you're sure you no longer need the extra protection.
        </Text>
      </Section>
    </EmailLayout>
  );
}
