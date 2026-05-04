'use server';

import { createHash, randomBytes } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireActiveOrg } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

const createSchema = z.object({
  name: z.string().min(1).max(80),
  /** 距离过期的天数；0 / undefined = 无过期时间。 */
  expiresInDays: z.number().int().min(0).max(3650).optional(),
});

const revokeSchema = z.object({ tokenId: z.string().min(1) });

const TOKEN_PREFIX = 'kitora_';
const RAW_BYTES = 32;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export async function createApiTokenAction(input: z.infer<typeof createSchema>) {
  const me = await requireActiveOrg();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const raw = `${TOKEN_PREFIX}${randomBytes(RAW_BYTES).toString('base64url')}`;
  const prefix = raw.slice(0, TOKEN_PREFIX.length + 4); // 例如 "kitora_aB3z"
  const tokenHash = hashToken(raw);

  const expiresAt = parsed.data.expiresInDays
    ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  // 双写：userId 是「创建者」，orgId 是「token 在哪个 org 内有效」（PR-1
  // 决策：一 token 一 org）。
  const created = await prisma.apiToken.create({
    data: {
      userId: me.userId,
      orgId: me.orgId,
      name: parsed.data.name,
      tokenHash,
      prefix,
      expiresAt,
    },
    select: { id: true, name: true, prefix: true, createdAt: true, expiresAt: true },
  });

  logger.info({ userId: me.userId, orgId: me.orgId, tokenId: created.id }, 'api-token-created');
  revalidatePath('/settings');

  return {
    ok: true as const,
    token: { ...created, raw }, // 原始令牌仅向用户显示一次
  };
}

export async function revokeApiTokenAction(input: z.infer<typeof revokeSchema>) {
  const me = await requireActiveOrg();
  const parsed = revokeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  // 仅吊销属于调用者 org 的令牌 — 防御 IDOR。
  // 我们也按 userId 约束，使 MEMBER 角色无法吊销另一个用户的令牌
  // （PR-3 将通过角色检查为 ADMIN / OWNER 放宽此限制）。
  const result = await prisma.apiToken.updateMany({
    where: {
      id: parsed.data.tokenId,
      orgId: me.orgId,
      userId: me.userId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) {
    return { ok: false as const, error: 'not-found' as const };
  }

  logger.info(
    { userId: me.userId, orgId: me.orgId, tokenId: parsed.data.tokenId },
    'api-token-revoked',
  );
  revalidatePath('/settings');
  return { ok: true as const };
}
