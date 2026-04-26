import { Button, Section, Text } from '@react-email/components';

import { EmailLayout } from './_layout';

interface Props {
  name?: string;
  appUrl?: string;
  /** Pre-formatted scheduled date — caller does the locale-aware formatting. */
  scheduledFor: string;
}

/**
 * RFC 0002 PR-4 — sent when a user requests account deletion. Acts as a
 * tripwire: if the recipient didn't actually schedule it, they have until
 * `scheduledFor` to sign in and cancel.
 */
export default function AccountDeletionScheduledEmail({
  name = 'there',
  appUrl = 'https://kitora.dev',
  scheduledFor,
}: Props) {
  return (
    <EmailLayout
      preview={`Your Kitora account is scheduled for deletion on ${scheduledFor}.`}
      heading="Your account is scheduled for deletion"
      footerNote="If you didn't request this, sign in and cancel deletion immediately, then change your password and review active sessions."
    >
      <Text className="text-base leading-6 text-zinc-700">
        Hi {name}, your Kitora account will be permanently deleted on{' '}
        <strong>{scheduledFor}</strong>. Until then you can sign in and cancel the deletion at any
        time. After that date, all your data — profile, organizations you own as the only member,
        API tokens, audit history visibility — is irrecoverable.
      </Text>
      <Section className="mt-2">
        <Button
          href={`${appUrl}/settings`}
          className="rounded-md bg-zinc-900 px-5 py-3 text-sm font-medium text-white"
        >
          Cancel deletion
        </Button>
      </Section>
    </EmailLayout>
  );
}
