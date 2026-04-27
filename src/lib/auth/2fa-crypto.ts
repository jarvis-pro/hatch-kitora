import 'server-only';

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { env } from '@/env';

/**
 * RFC 0002 PR-2 — 2FA 的仅服务器端密码学。
 *
 * 两个职责：
 *
 *   1. 共享 TOTP 秘密的 AES-256-GCM 加密。密钥通过 HKDF 从
 *      `AUTH_SECRET` + `userId` 衍生（行 ID 是盐），使单行泄露
 *      不危及表的其余部分。格式：`[12 字节 IV][16 字节认证标签][密文]`
 *      打包到一个 Buffer。
 *
 *   2. 备份码生成 + 验证。每个用户 10 个码，在数据库中 sha256 哈希；
 *      我们删除而非标记使用，所以读取该行的攻击者无法推断剩余多少。
 *
 * 纯 TOTP / base32 帮助程序存放在 `./2fa-totp.ts` 中，以便测试代码
 * 可导入它们而无需拉入 `server-only`（在 RSC 上下文外导入时抛出）。
 */

// 重新导出纯帮助程序，使调用者不需知道分割。
export {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  totpNow,
  verifyTotp,
} from './2fa-totp';

// ─── HKDF 衍生的每用户密钥 ──────────────────────────────────────────────────

const KEY_INFO = 'kitora-2fa-v1';
const KEY_LEN = 32;

function deriveKey(userId: string): Buffer {
  // Node 的 hkdfSync 返回 ArrayBuffer。
  return Buffer.from(hkdfSync('sha256', env.AUTH_SECRET, userId, KEY_INFO, KEY_LEN));
}

// ─── AES-256-GCM 加密 / 解密 ──────────────────────────────────────────────

const IV_LEN = 12;
const TAG_LEN = 16;

export function encryptSecret(userId: string, plaintext: Buffer): Buffer {
  const key = deriveKey(userId);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decryptSecret(userId: string, packed: Buffer): Buffer {
  if (packed.length < IV_LEN + TAG_LEN) {
    throw new Error('encrypted-secret-too-short');
  }
  const iv = packed.subarray(0, IV_LEN);
  const tag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = packed.subarray(IV_LEN + TAG_LEN);
  const key = deriveKey(userId);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ─── 备份码 ───────────────────────────────────────────────────────────────
//
// 每个用户 10 个一次性码。我们仅在启用 / 重新生成时显示一次，
// 数据库仅存储 sha256(code)。验证时，我们查找行，找到匹配的哈希，
// 并**从数组中删除它**（一次性）。

const BACKUP_CODE_COUNT = 10;
const BACKUP_GROUP_LEN = 4;
const BACKUP_GROUPS = 2;
// Crockford 风格字母表 — 放弃模糊的 0/O/1/I。
const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateOneBackupCode(): string {
  const bytes = randomBytes(BACKUP_GROUP_LEN * BACKUP_GROUPS);
  let chars = '';
  for (let i = 0; i < bytes.length; i++) {
    // randomBytes 总是返回请求长度的缓冲区，所以索引在范围内 —
    // 断言以满足 noUncheckedIndexedAccess。
    chars += BACKUP_ALPHABET[bytes[i]! % BACKUP_ALPHABET.length];
  }
  // "XXXX-XXXX" — 易于从打印表中复制。
  const groups: string[] = [];
  for (let g = 0; g < BACKUP_GROUPS; g++) {
    groups.push(chars.slice(g * BACKUP_GROUP_LEN, (g + 1) * BACKUP_GROUP_LEN));
  }
  return groups.join('-');
}

export function generateBackupCodes(): { plain: string[]; hashes: string[] } {
  const plain: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const code = generateOneBackupCode();
    plain.push(code);
    hashes.push(hashBackupCode(code));
  }
  return { plain, hashes };
}

export function hashBackupCode(code: string): string {
  // 规范化，使用户键入"abcd-efgh"或"ABCDEFGH"都有效。
  const normalized = code.replace(/-/g, '').toUpperCase();
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * 在用户的哈希数组中查找备份码 — 返回匹配的哈希
 * （使调用者可从数组中删除它）或 null。
 */
export function findBackupCodeHash(userInput: string, hashes: readonly string[]): string | null {
  if (!/^[A-Z0-9-]{4,32}$/i.test(userInput)) return null;
  const candidate = hashBackupCode(userInput);
  for (const h of hashes) {
    // 恒定时间按元素比较。
    if (h.length === candidate.length) {
      const a = Buffer.from(h, 'hex');
      const b = Buffer.from(candidate, 'hex');
      if (a.length === b.length && timingSafeEqual(a, b)) {
        return h;
      }
    }
  }
  return null;
}
