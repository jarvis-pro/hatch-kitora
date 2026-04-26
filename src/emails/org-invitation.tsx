import { Button, Section, Text } from '@react-email/components';
import { OrgRole } from '@prisma/client';

import { EmailLayout } from './_layout';

interface Props {
  orgName?: string;
  inviterName?: string;
  role?: OrgRole;
  acceptUrl?: string;
}

export default function OrgInvitationEmail({
  orgName = 'an organization',
  inviterName,
  role = OrgRole.MEMBER,
  acceptUrl = 'https://kitora.dev',
}: Props) {
  const inviter = inviterName ?? 'A team admin';
  const roleLabel = role === OrgRole.ADMIN ? 'admin' : 'member';

  return (
    <EmailLayout
      preview={`${inviter} invited you to ${orgName} on Kitora`}
      heading={`You're invited to ${orgName}`}
      footerNote="If you didn't expect this invitation, you can safely ignore this email — the link expires automatically in 7 days."
    >
      <Text className="text-base leading-6 text-zinc-700">
        {inviter} has invited you to join <strong>{orgName}</strong> on Kitora as a {roleLabel}.
      </Text>
      <Section className="mt-2">
        <Button
          href={acceptUrl}
          className="rounded-md bg-zinc-900 px-5 py-3 text-sm font-medium text-white"
        >
          Accept invitation
        </Button>
      </Section>
      <Text className="text-sm text-zinc-600">
        This link expires in 7 days. You'll need to sign in (or create an account) using this email
        address to accept.
      </Text>
    </EmailLayout>
  );
}
