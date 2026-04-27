// 注意：故意**不是** `'server-only'` — Playwright e2e 测试
// 通过 `provisionSsoUser`（RFC 0004 PR-2）传递导入此文件，
// 之前通过 cron 驱动的流程。传递性 `@/lib/db`（prisma）
// + `@/lib/request`（next/headers）依赖仅限 Node，所以意外的客户端
// 捆绑仍会大声失败。
import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { currentRegion } from '@/lib/region';
import { getClientIp } from '@/lib/request';
import { bridgeAuditToWebhook } from '@/lib/webhooks/from-audit';

/** 规范操作码 — 保持这些稳定；UI 将其映射到翻译副本。 */
export const AUDIT_ACTIONS = [
  'role.set',
  'account.password_changed',
  'account.deleted',
  'account.sign_out_everywhere',
  'billing.subscription_changed',
  'org.created',
  'org.updated',
  'org.deleted',
  'member.invited',
  'member.joined',
  'member.removed',
  'member.role_changed',
  'ownership.transferred',
  // RFC 0002 PR-1 — 活跃会话
  'session.revoked',
  // RFC 0002 PR-2 — 2FA
  '2fa.enabled',
  '2fa.disabled',
  '2fa.backup_regenerated',
  // RFC 0002 PR-3 — 数据导出
  'account.export_requested',
  'org.export_requested',
  // RFC 0002 PR-4 — 删除宽限期 + Org 2FA 强制
  'account.deletion_scheduled',
  'account.deletion_cancelled',
  'org.2fa_required_changed',
  // RFC 0003 PR-1 — 出站 webhook
  'webhook.endpoint_created',
  'webhook.endpoint_updated',
  'webhook.endpoint_deleted',
  'webhook.secret_rotated',
  'webhook.endpoint_auto_disabled',
  // RFC 0004 PR-1 — SSO（SAML + OIDC + SCIM）
  'sso.idp_created',
  'sso.idp_updated',
  'sso.idp_deleted',
  'sso.scim_token_rotated',
  'sso.login_succeeded',
  'sso.login_failed',
  'sso.jit_user_created',
  'scim.user_provisioned',
  'scim.user_deprovisioned',
  // RFC 0007 PR-2 — WebAuthn / Passkey
  'webauthn.credential_added',
  'webauthn.credential_renamed',
  'webauthn.credential_removed',
  'webauthn.login_succeeded',
  'webauthn.tfa_succeeded',
  // RFC 0008 PR-3 — 后台任务（管理员手动操作）
  // 注意：runner 自己**不**为每个 DEAD_LETTER 写审计 — 那是噪音、由
  // metrics + Sentry 已经覆盖；只在 admin /admin/jobs UI 上手动 cancel /
  // retry 一行 DLQ 时写审计（对应 PR-4）。
  'job.cancelled',
  'job.retried',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * 将审计操作码转换为 i18n 键。
 * `next-intl` 拒绝键段中的 `.`，因为它解析点为嵌套。
 * 我们在数据库中保持点号操作码以保持可读性，仅在查找消息字符串时
 * 将其转换为下划线形式。
 * @param action - 审计操作码。
 * @returns i18n 键。
 */
export function auditActionToI18nKey(action: string): string {
  return action.replaceAll('.', '_');
}

/**
 * 记录审计日志的输入。
 * @property actorId - 行为者的 ID；如果是平台级操作则为 null。
 * @property orgId - 此审计行的组织范围。为租户范围的操作传递活跃 org；为平台级操作传递 `null`。
 * @property action - 审计操作码。
 * @property target - 操作的目标资源 ID。
 * @property metadata - 操作的额外元数据。
 */
interface RecordAuditInput {
  actorId: string | null;
  orgId?: string | null;
  action: AuditAction;
  target?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/**
 * 记录审计日志条目。尽力而为 —— 失败被记录但永不抛出，所以审计存储
 * 中断无法阻止基础业务操作。
 * @param input - 审计输入。
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    const ip = await getClientIp();
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        orgId: input.orgId ?? null,
        action: input.action,
        target: input.target ?? null,
        metadata: input.metadata,
        ip: ip === 'unknown' ? null : ip,
        // RFC 0005 —— 用部署区域标记该行。调用者永不传递区域：
        // 单个流程仅服务一个区域，所以任何「覆盖」意味着调用点错误。
        region: currentRegion(),
      },
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'audit-write-failed');
  }

  // RFC 0003 PR-2 — 扇出至订阅的 webhook 端点。包装在自己的 try 中
  // 使 webhook 簿记错误永不从审计写冒出（审计行本身上面成功）。
  try {
    await bridgeAuditToWebhook({
      orgId: input.orgId ?? null,
      action: input.action,
      actorId: input.actorId,
      target: input.target ?? null,
      metadata: input.metadata,
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'webhook-bridge-failed');
  }
}
