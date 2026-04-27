// 注意：故意*没有* `'server-only'` 标记 — Playwright e2e 测试通过 SSO 流的
// `issueSsoSession` 辅助函数在进程内驱动 `createDeviceSession` / `hashSid`。
// 传递的 `@/lib/db` (prisma) + `node:crypto` 导入已经阻止了意外的客户端打包。
import { createHash, randomBytes } from 'node:crypto';

import { prisma } from '@/lib/db';

/**
 * 活跃会话管道（RFC 0002 PR-1）。
 *
 * 每个签发的 JWT 都包含一个随机的 `sid` 声明 — sha256(sid) 是
 * `DeviceSession` 中的行键。我们从不存储原始 sid；它仅存在于签名的
 * JWT cookie 中。
 *
 * `src/lib/auth/index.ts` 中的 Node 侧 jwt() 回调在每个请求上调用
 * `validateDeviceSession()` — 缺失或已撤销的行强制重新登录。
 * `signOutEverywhere()` 和按行撤销都会翻转 `revokedAt`，因此用户可以
 * 从 UI 管理他们的设备群。
 */

/** 生成一个新鲜的原始 sid 以嵌入到 JWT 声明中。 */
export function generateSid(): string {
  return randomBytes(32).toString('base64url');
}

/** 为数据库存储/查找散列化一个原始 sid。 */
export function hashSid(rawSid: string): string {
  return createHash('sha256').update(rawSid).digest('hex');
}

interface CreateInput {
  userId: string;
  rawSid: string;
  userAgent?: string | null;
  ip?: string | null;
}

/** 在登录时持久化一个新的 DeviceSession 行。返回行 ID。 */
export async function createDeviceSession(input: CreateInput): Promise<string> {
  const row = await prisma.deviceSession.create({
    data: {
      userId: input.userId,
      sidHash: hashSid(input.rawSid),
      userAgent: input.userAgent?.slice(0, 1024) ?? null,
      ip: input.ip ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

interface ValidateResult {
  ok: boolean;
  sidHash: string;
}

/**
 * 验证 sid 仍映射到未撤销的行。从每个请求的 jwt() 回调调用 —
 * 保持速度快（一次索引唯一查找）。
 *
 * 还会以 60 秒的节流方式机会性地刷新 `lastSeenAt`，这样会话列表保持
 * 有意义而不会使该行成为热点。
 */
export async function validateDeviceSession(rawSid: string): Promise<ValidateResult> {
  const sidHash = hashSid(rawSid);
  const row = await prisma.deviceSession.findUnique({
    where: { sidHash },
    select: { revokedAt: true },
  });
  if (!row || row.revokedAt) {
    return { ok: false, sidHash };
  }
  // 异步触发节流的 lastSeenAt 更新。这里的错误不能阻止认证 —
  // 最坏的情况是 UI 显示略微过时的时间戳。
  void touchDeviceSession(sidHash);
  return { ok: true, sidHash };
}

const TOUCH_THROTTLE_MS = 60_000;

/**
 * 节流的 `lastSeenAt` 更新。带有 `lastSeenAt < cutoff` 过滤器的
 * `updateMany` 在并发下自然是幂等的 — 只有超过截止日期的请求
 * 才会实际写入。
 */
async function touchDeviceSession(sidHash: string): Promise<void> {
  const cutoff = new Date(Date.now() - TOUCH_THROTTLE_MS);
  try {
    await prisma.deviceSession.updateMany({
      where: { sidHash, lastSeenAt: { lt: cutoff } },
      data: { lastSeenAt: new Date() },
    });
  } catch {
    // 吞掉错误 — 见上面的注释。
  }
}

/** 通过行 ID 撤销单个会话。如果实际撤销了一行，返回 true。 */
export async function revokeDeviceSessionById(userId: string, id: string): Promise<boolean> {
  const result = await prisma.deviceSession.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}

/**
 * 撤销用户的每个活跃会话。由 `signOutEverywhereAction`、
 * `changePasswordAction` 和未来的账户删除流与 `User.sessionVersion`
 * 增量一起使用。
 */
export async function revokeAllDeviceSessions(userId: string): Promise<number> {
  const result = await prisma.deviceSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export interface DeviceSessionView {
  id: string;
  userAgent: string | null;
  ip: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  current: boolean;
}

/**
 * 列出用户的活跃会话供设置 UI 使用。调用者自己的 sidHash 被传递
 * 以便我们可以标记"当前"行 — UI 为其隐藏撤销按钮（没有脚枪）。
 */
export async function listActiveDeviceSessions(
  userId: string,
  currentSidHash: string | null,
): Promise<DeviceSessionView[]> {
  const rows = await prisma.deviceSession.findMany({
    where: { userId, revokedAt: null },
    orderBy: { lastSeenAt: 'desc' },
    select: {
      id: true,
      sidHash: true,
      userAgent: true,
      ip: true,
      lastSeenAt: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    userAgent: r.userAgent,
    ip: r.ip,
    lastSeenAt: r.lastSeenAt,
    createdAt: r.createdAt,
    current: currentSidHash !== null && r.sidHash === currentSidHash,
  }));
}
