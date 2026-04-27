import 'server-only';

import { createHash } from 'node:crypto';

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

import { getPersonalOrgIdForUser } from '@/lib/auth/session';

export interface ApiTokenPrincipal {
  userId: string;
  /**
   * 持有者正在操作的组织。PR-2 合同：每个 API 调用都携带 org 上下文；
   * 一个令牌绑定到恰好一个 org（RFC-0001 §9 决策）。在迁移窗口期间，
   * 在 orgId 列存在之前创建的令牌回退到用户的 personal org。
   */
  orgId: string;
  tokenId: string;
}

const HEADER_RE = /^Bearer\s+([A-Za-z0-9_-]{20,})$/;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * 对照 ApiToken 表验证 `Authorization: Bearer <token>` 头。
 * 任何失败（头格式错误、未知 / 已吊销 / 已过期令牌、无可解析 org）返回 null。
 * 成功时，副作用：提升 `lastUsedAt`。
 *
 * 我们接受的令牌格式：`kitora_<random>`。`kitora_` 前缀纯粹用于人工检查；
 * 验证器仅检查长度 / 字符集。
 */
export async function authenticateBearer(request: Request): Promise<ApiTokenPrincipal | null> {
  const header = request.headers.get('authorization');
  if (!header) return null;

  const match = HEADER_RE.exec(header.trim());
  if (!match) return null;

  // 第一个捕获组是令牌字符；非空是因为正则表达式要求匹配。
  const raw = match[1] as string;
  const tokenHash = hashToken(raw);

  const token = await prisma.apiToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, orgId: true, revokedAt: true, expiresAt: true },
  });
  if (!token) return null;
  if (token.revokedAt) return null;
  if (token.expiresAt && token.expiresAt.getTime() < Date.now()) return null;

  // 解析 org：token.orgId 是真实来源；PR-1 前的令牌可能仍为 null（反填
  // 应该已捕获这些但我们也防守），此时回退到所有者的 personal org。
  const orgId = token.orgId ?? (await getPersonalOrgIdForUser(token.userId));
  if (!orgId) {
    // 无法解析范围 — 拒绝而非默默扩大访问权限。
    logger.warn({ tokenId: token.id, userId: token.userId }, 'apitoken-no-org');
    return null;
  }

  // 尽力触摸 — 永不阻止此请求。
  prisma.apiToken
    .update({
      where: { id: token.id },
      data: { lastUsedAt: new Date() },
    })
    .catch((err) => logger.warn({ err, tokenId: token.id }, 'apitoken-touch-failed'));

  return { userId: token.userId, orgId, tokenId: token.id };
}
