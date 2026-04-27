import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

/**
 * 自管理流的令牌实用程序（邮件验证、密码重置）。
 *
 * 惯例：
 *   - 原始令牌（URL 安全随机字符串）通过电子邮件传递给用户。
 *   - 只有 `sha256(token)` 被持久化在数据库中。
 *   - 令牌是一次性使用：成功时删除行（或标记为已消费）。
 */

const RAW_TOKEN_BYTES = 32;

/** 生成一个 URL 安全的不透明令牌（~43 个字符，256 位熵）。 */
export function generateRawToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString('base64url');
}

/** 用作 DB 查找键的稳定哈希。 */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** 默认生命周期 — 如需要，可按流微调。 */
export const TOKEN_TTL = {
  emailVerification: 1000 * 60 * 60 * 24, // 24h
  passwordReset: 1000 * 60 * 30, // 30min
} as const;

export function expiresAt(ttlMs: number): Date {
  return new Date(Date.now() + ttlMs);
}
