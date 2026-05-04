// 注意：这里故意*不*是 `'server-only'` ——Playwright e2e 套件
// 针对真实端点 ID 往返 `encryptSecret` / `decryptSecret`
// 以防止经常出现的"密文是有损的"回归。传递的 `@/env` 导入
// 本身是服务器把守的（在启动时对 `process.env` 进行验证），
// 所以即使没有显式标记，意外的客户端捆绑仍然会失败。
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

import { env } from '@/env';

/**
 * RFC 0003 PR-1 / PR-2 — webhook 秘密助手。
 *
 * 格式：`whsec_<base64url(32 bytes)>` ——与 Stripe / GitHub
 * 相同的命名约定，以便集成商一目了然地识别形状。
 *
 * 每个秘密的两条簿记：
 *
 *   1. `secretHash` — 明文的 sha256。用作指纹和
 *      遗留查找（PR-1 只用此字段写行）。
 *   2. `encSecret`  — 明文的 AES-256-GCM 密文，密钥派生
 *      自 AUTH_SECRET + 端点 ID 通过 HKDF。cron 解密此
 *      以计算出站 HMAC（PR-2 添加它）。
 *
 * `secretPrefix` 是 base64url 正文的前 8 个字符（在
 * `whsec_` 前缀之后）——在 UI 中显示是安全的。
 */

const PREFIX = 'whsec_';
const RAW_BYTES = 32;
const KEY_INFO = 'kitora-webhook-v1';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

export interface FreshSecret {
  /** 返回给用户的明文（一次性）。*/
  plain: string;
  /** 明文的 sha256 十六进制——指纹 / 向后兼容。*/
  hash: string;
  /** base64url 正文的前 8 个字符——在 UI 中显示是安全的。*/
  prefix: string;
  /**
   * 加密助手闭包——使用新创建的端点 ID 调用
   * 以生成我们持久化的密文。我们分成两步，因为
   * ID 仅在行插入后才知道。
   */
  encryptForEndpoint: (endpointId: string) => Buffer;
}

export function generateWebhookSecret(): FreshSecret {
  const raw = randomBytes(RAW_BYTES).toString('base64url');
  const plain = `${PREFIX}${raw}`;
  return {
    plain,
    hash: createHash('sha256').update(plain).digest('hex'),
    prefix: raw.slice(0, 8),
    encryptForEndpoint: (endpointId) => encryptSecret(endpointId, plain),
  };
}

export function hashWebhookSecret(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

// ─── 通过 HKDF 派生的每端点密钥 ──────────────────────────────────────────────

function deriveKey(endpointId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', env.AUTH_SECRET, endpointId, KEY_INFO, KEY_LEN));
}

export function encryptSecret(endpointId: string, plaintext: string): Buffer {
  const key = deriveKey(endpointId);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decryptSecret(endpointId: string, packed: Buffer): string {
  if (packed.length < IV_LEN + TAG_LEN) {
    throw new Error('webhook-secret-too-short');
  }
  const iv = packed.subarray(0, IV_LEN);
  const tag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = packed.subarray(IV_LEN + TAG_LEN);
  const key = deriveKey(endpointId);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
