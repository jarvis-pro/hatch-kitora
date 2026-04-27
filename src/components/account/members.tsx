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

/**
 * 组织成员行数据结构
 */
export interface MemberRow {
  userId: string;
  name: string | null;
  email: string;
  role: OrgRole;
  joinedAt: Date;
  /** 当前登录用户在此行数据中的标识 */
  self: boolean;
}

/**
 * 待处理邀请行数据结构
 */
export interface InvitationRow {
  id: string;
  email: string;
  role: OrgRole;
  expiresAt: Date;
}

/**
 * MembersList 组件 Props
 * @property {MemberRow[]} members - 组织成员列表
 * @property {InvitationRow[]} invitations - 待处理邀请列表
 * @property {OrgRole} myRole - 当前用户在该组织的角色，用于控制可用操作
 */
interface Props {
  members: MemberRow[];
  invitations: InvitationRow[];
  myRole: OrgRole;
}

/**
 * 格式化日期为 YYYY-MM-DD 格式
 * @param d - 要格式化的日期
 * @returns 格式化后的日期字符串
 */
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 组织成员管理列表组件
 * 展示组织成员和待处理邀请，支持修改成员角色、移除成员、转移所有权等操作。
 * 权限控制基于当前用户角色（OWNER/ADMIN/MEMBER）。
 * @param {Props} props
 * @returns 成员管理列表
 */
export function MembersList({ members, invitations, myRole }: Props) {
  const t = useTranslations('orgs.members');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // 确定当前用户是否有管理权限
  const canManage = myRole === OrgRole.OWNER || myRole === OrgRole.ADMIN;
  // 只有 OWNER 才能转移所有权
  const canTransfer = myRole === OrgRole.OWNER;

  /**
   * 修改成员角色
   * @param userId - 成员 ID
   * @param role - 新角色
   */
  const onChangeRole = (userId: string, role: OrgRole) => {
    startTransition(async () => {
      // 调用服务端 action 更新成员角色
      const result = await updateMemberRoleAction({ userId, role });
      if (result.ok) {
        toast.success(t('roleChanged'));
        router.refresh();
      } else {
        toast.error(t(`errors.${result.error}` as 'errors.generic') || t('errors.generic'));
      }
    });
  };

  /**
   * 移除组织成员
   * @param userId - 成员 ID
   */
  const onRemove = (userId: string) => {
    if (!confirm(t('confirmRemove'))) return;
    startTransition(async () => {
      // 调用服务端 action 移除成员
      const result = await removeMemberAction({ userId });
      if (result.ok) {
        toast.success(t('removed'));
        router.refresh();
      } else {
        toast.error(t('errors.generic'));
      }
    });
  };

  /**
   * 转移组织所有权给另一成员
   * @param userId - 新所有者的用户 ID
   */
  const onTransfer = (userId: string) => {
    if (!confirm(t('confirmTransfer'))) return;
    startTransition(async () => {
      // 调用服务端 action 转移所有权
      const result = await transferOwnershipAction({ userId });
      if (result.ok) {
        toast.success(t('transferred'));
        router.refresh();
      } else {
        toast.error(t('errors.generic'));
      }
    });
  };

  /**
   * 撤销邀请
   * @param invitationId - 邀请 ID
   */
  const onRevoke = (invitationId: string) => {
    startTransition(async () => {
      // 调用服务端 action 撤销邀请
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
