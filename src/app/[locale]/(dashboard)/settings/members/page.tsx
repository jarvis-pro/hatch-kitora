import type { OrgRole } from '@prisma/client';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { InviteForm } from '@/components/account/invite-form';
import { MembersList, type InvitationRow, type MemberRow } from '@/components/account/members';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireActiveOrg } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { can } from '@/lib/orgs/permissions';

export const metadata: Metadata = { title: 'Members' };
export const dynamic = 'force-dynamic';

export default async function MembersPage() {
  const me = await requireActiveOrg().catch(() => null);
  if (!me) redirect('/login');

  // 个人组织没有有意义的成员概念——反弹。
  if (me.slug.startsWith('personal-')) redirect('/settings');

  const t = await getTranslations('orgs.members');

  const [memberships, invitations] = await Promise.all([
    prisma.membership.findMany({
      where: { orgId: me.orgId },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
      select: {
        role: true,
        joinedAt: true,
        user: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.invitation.findMany({
      where: { orgId: me.orgId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, role: true, expiresAt: true },
    }),
  ]);

  const members: MemberRow[] = memberships.map((m) => ({
    userId: m.user.id,
    name: m.user.name,
    email: m.user.email,
    role: m.role,
    joinedAt: m.joinedAt,
    self: m.user.id === me.userId,
  }));
  const pendingInvitations: InvitationRow[] = invitations
    .filter((i) => i.expiresAt.getTime() > Date.now())
    .map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      expiresAt: i.expiresAt,
    }));

  const canInvite = can(me.role, 'member.invite');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {canInvite ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('invite.title')}</CardTitle>
            <CardDescription>{t('invite.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <InviteForm />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('listCardTitle')}</CardTitle>
          <CardDescription>{t('listCardDescription', { count: members.length })}</CardDescription>
        </CardHeader>
        <CardContent>
          <MembersList
            members={members}
            invitations={pendingInvitations}
            myRole={me.role as OrgRole}
          />
        </CardContent>
      </Card>
    </div>
  );
}
