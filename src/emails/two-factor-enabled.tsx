import { Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

interface Props {
  name?: string;
  appUrl?: string;
}

/**
 * RFC 0002 PR-2 — sent right after a successful 2FA enrollment confirmation.
 * The point of this email is *not* to celebrate; it's to alert the account
 * owner if someone *else* just turned 2FA on (e.g. a hijacked session). If
 * the recipient didn't enable 2FA, they should sign in and disable it.
 */
export default function TwoFactorEnabledEmail({
  name = 'there',
  appUrl = 'https://kitora.dev',
}: Props) {
  return (
    <EmailLayout
      preview="Two-factor authentication is now on for your Kitora account."
      heading="Two-factor authentication enabled"
      footerNote="If this wasn't you, sign in and disable 2FA from Settings → Security immediately, then change your password."
    >
      <Text className="text-base leading-6 text-zinc-700">
        Hi {name}, two-factor authentication has just been turned on for your Kitora account. From
        now on you'll be asked for a 6-digit code from your authenticator app every time you sign
        in.
      </Text>
      <Section className="mt-2">
        <Text className="text-sm text-zinc-600">
          Keep your backup codes somewhere safe — they're the only way back in if you lose access to
          your authenticator. You can review or regenerate them at{' '}
          <a href={`${appUrl}/settings`} className="text-zinc-900 underline">
            Settings → Security
          </a>
          .
        </Text>
      </Section>
    </EmailLayout>
  );
}
