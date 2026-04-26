'use client';

import { OrgRole } from '@prisma/client';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/routing';
import {
  removeMemberAction,
  transferOwnershipAction,
  updateMemberRoleAction,
} from '@/lib/orgs/actions';
import { revokeInvitationAction } from '@/lib/orgs/invitations';
import { cn } from '@/lib/utils';

export interface MemberRow {
  userId: string;
  name: string | null;
  email: string;
  role: OrgRole;
  joinedAt: Date;
  /** True for the row representing the currently logged-in user. */
  self: boolean;
}

export interface InvitationRow {
  id: string;
  email: string;
  role: OrgRole;
  expiresAt: Date;
}

interface Props {
  members: MemberRow[];
  invitations: InvitationRow[];
  /** Caller's role in this org — controls which actions render. */
  myRole: OrgRole;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function MembersList({ members, invitations, myRole }: Props) {
  const t = useTranslations('orgs.members');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const canManage = myRole === OrgRole.OWNER || myRole === OrgRole.ADMIN;
  const canTransfer = myRole === OrgRole.OWNER;

  const onChangeRole = (userId: string, role: OrgRole) => {
    startTransition(async () => {
      const result = await updateMemberRoleAction({ userId, role });
      if (result.ok) {
        toast.success(t('roleChanged'));
        router.refresh();
      } else {
        toast.error(t(`errors.${result.error}` as 'errors.generic') || t('errors.generic'));
      }
    });
  };

  const onRemove = (userId: string) => {
    if (!confirm(t('confirmRemove'))) return;
    startTransition(async () => {
      const result = await removeMemberAction({ userId });
      if (result.ok) {
        toast.success(t('removed'));
        router.refresh();
      } else {
        toast.error(t('errors.generic'));
      }
    });
  };

  const onTransfer = (userId: string) => {
    if (!confirm(t('confirmTransfer'))) return;
    startTransition(async () => {
      const result = await transferOwnershipAction({ userId });
      if (result.ok) {
        toast.success(t('transferred'));
        router.refresh();
      } else {
        toast.error(t('errors.generic'));
      }
    });
  };

  const onRevoke = (invitationId: string) => {
    startTransition(async () => {
      const result = await revokeInvitationAction({ invitationId });
      if (result.ok) {
        toast.success(t('inviteRevoked'));
        router.refresh();
      } else {
        toast.error(t('errors.generic'));
      }
    });
  };

  return (
    <div className="space-y-8">
      <div>
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">{t('listTitle')}</h3>
        <ul className="divide-y rounded-md border">
          {members.map((m) => (
            <li
              key={m.userId}
              className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {m.name ?? m.email}
                  {m.self ? (
                    <span className="ml-2 rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground">
                      {t('youTag')}
                    </span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {m.email} · {t('joined', { date: fmtDate(m.joinedAt) })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {m.role === OrgRole.OWNER ? (
                  <span className="rounded-md border bg-amber-500/10 px-2 py-1 text-xs">
                    {t('roles.OWNER')}
                  </span>
                ) : canManage && !m.self ? (
                  <select
                    defaultValue={m.role}
                    onChange={(e) => onChangeRole(m.userId, e.target.value as OrgRole)}
                    disabled={pending}
                    className={cn(
                      'rounded-md border bg-background px-2 py-1 text-xs',
                      pending && 'opacity-60',
                    )}
                    aria-label={t('roleLabel')}
                  >
                    <option value={OrgRole.MEMBER}>{t('roles.MEMBER')}</option>
                    <option value={OrgRole.ADMIN}>{t('roles.ADMIN')}</option>
                  </select>
                ) : (
                  <span className="rounded-md border px-2 py-1 text-xs">
                    {t(`roles.${m.role}`)}
                  </span>
                )}

                {canTransfer && !m.self && m.role !== OrgRole.OWNER ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onTransfer(m.userId)}
                    disabled={pending}
                  >
                    {t('transfer')}
                  </Button>
                ) : null}

                {canManage && !m.self && m.role !== OrgRole.OWNER ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onRemove(m.userId)}
                    disabled={pending}
                  >
                    {t('remove')}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {invitations.length > 0 ? (
        <div>
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">{t('pendingTitle')}</h3>
          <ul className="divide-y rounded-md border">
            {invitations.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">{inv.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('roles.' + inv.role)} · {t('expires', { date: fmtDate(inv.expiresAt) })}
                  </p>
                </div>
                {canManage ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onRevoke(inv.id)}
                    disabled={pending}
                  >
                    {t('revokeInvite')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
