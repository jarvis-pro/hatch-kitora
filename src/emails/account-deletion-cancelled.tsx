import { Text } from '@react-email/components';

import { EmailLayout } from './_layout';

interface Props {
  name?: string;
}

/**
 * RFC 0002 PR-4 — sent when a user cancels their scheduled deletion. The
 * email is intentionally short; the matching action UI confirms the
 * cancellation in-app, this is just the audit trail to the inbox.
 */
export default function AccountDeletionCancelledEmail({ name = 'there' }: Props) {
  return (
    <EmailLayout
      preview="Your Kitora account deletion has been cancelled."
      heading="Account deletion cancelled"
    >
      <Text className="text-base leading-6 text-zinc-700">
        Hi {name}, the scheduled deletion of your Kitora account has been cancelled. Your account is
        back to its normal state.
      </Text>
    </EmailLayout>
  );
}
