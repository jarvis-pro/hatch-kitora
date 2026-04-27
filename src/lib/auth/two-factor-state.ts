// RFC 0007 §4.6 — 跨方法 2FA 状态评估。
//
// `User.twoFactorEnabled` 由 RFC 0002 PR-2 引入作为"用户拥有 TOTP"的
// 反范式化标志。RFC 0007 扩展了含义：当且仅当用户拥有*任何*第二因子时
// 为真 — TOTP 启用或至少一行 WebAuthnCredential。翻转 TOTP 或密钥状态的
// 调用者通过 `recomputeTwoFactorEnabled()` 路由，以便列保持同步，
// 而不在每个位置硬编码 OR。
//
// 注意：RFC 0007 PR-2 仅从密钥添加/删除路径中连接 —
// TOTP 启用/禁用服务器操作仍分别硬编码 true/false（其 pre-RFC-0007
// 行为）。这对 TOTP 唯一的大多数用户是正确的；角点情况是拥有 TOTP 和
// 密钥的用户在禁用 TOTP 后获得 `twoFactorEnabled = false` 是一个已知的
// 问题，可通过改造这两个调用点来使用此辅助函数来修复。RFC 0007 §4.6
// 指出了这一点。

import 'server-only';

import type { Prisma, PrismaClient } from '@prisma/client';

import { prisma } from '@/lib/db';

/** 纯决策：给定变更后的因子标志，列应该为 true 吗？ */
export function shouldTwoFactorBeEnabled(opts: {
  totpEnabled: boolean;
  passkeyCount: number;
}): boolean {
  return opts.totpEnabled || opts.passkeyCount > 0;
}

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * 基于 `TwoFactorSecret` + `WebAuthnCredential` 的*当前*状态，
 * 为 `userId` 重新评估 `User.twoFactorEnabled`。如果新值与现有值不同，
 * 则写入新值。返回写入后的值。
 *
 * 从 `prisma.$transaction` 内部调用时，传递显式 `tx` —
 * 辅助函数加入事务而不是打开新连接（避免读取中途提交的陈旧数据）。
 */
export async function recomputeTwoFactorEnabled(userId: string, tx: Tx = prisma): Promise<boolean> {
  const [totp, passkeyCount, current] = await Promise.all([
    tx.twoFactorSecret.findUnique({
      where: { userId },
      select: { enabledAt: true },
    }),
    tx.webAuthnCredential.count({ where: { userId } }),
    tx.user.findUnique({
      where: { id: userId },
      select: { twoFactorEnabled: true },
    }),
  ]);

  const next = shouldTwoFactorBeEnabled({
    totpEnabled: totp?.enabledAt != null,
    passkeyCount,
  });

  if (current?.twoFactorEnabled !== next) {
    await tx.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: next },
    });
  }
  return next;
}
