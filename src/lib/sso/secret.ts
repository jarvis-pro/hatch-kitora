// 注意：这里刻意*不*设置 'server-only' — server action、server
// 组件和（最终）Playwright e2e 套件都导入此模块。可传递的
// `@/env` 运行时验证已 gate 客户端打包。
//
// 两块秘密材料存在于 `IdentityProvider`：
//
//   1. OIDC `client_secret` — AES-256-GCM 密文，密钥来自
//      `AUTH_SECRET + endpoint id` 的 HKDF。与 RFC 0002 / 0003 相同信封。
//   2. SCIM token — `scim_<base64url(32)>`。我们持久化 `sha256(plaintext)`
//      + 前 8 个字符（"prefix"）用于 UI / 日志显示。明文在
//      创建/轮换时恰好返回用户一次。

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

import { env } from '@/env';

// ─── OIDC client secret 信封 ────────────────────────────────────────────

const OIDC_KEY_INFO = 'kitora-sso-oidc-v1';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveOidcKey(providerId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', env.AUTH_SECRET, providerId, OIDC_KEY_INFO, KEY_LEN));
}

export function encryptOidcSecret(providerId: string, plaintext: string): Buffer {
  const key = deriveOidcKey(providerId);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decryptOidcSecret(providerId: string, packed: Buffer): string {
  if (packed.length < IV_LEN + TAG_LEN) {
    throw new Error('oidc-secret-too-short');
  }
  const iv = packed.subarray(0, IV_LEN);
  const tag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = packed.subarray(IV_LEN + TAG_LEN);
  const key = deriveOidcKey(providerId);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ─── SCIM token 发出 ────────────────────────────────────────────────────

const SCIM_PREFIX = 'scim_';
const SCIM_RAW_BYTES = 32;

export interface FreshScimToken {
  /** 明文向用户交付一次。格式：`scim_<base64url(32)>`。 */
  plain: string;
  /** 明文的 sha256 hex — 指纹存储在 DB。 */
  hash: string;
  /** base64url 体的前 8 个字符 — 可安全在 UI / 日志中显示。 */
  prefix: string;
}

export function generateScimToken(): FreshScimToken {
  const raw = randomBytes(SCIM_RAW_BYTES).toString('base64url');
  const plain = `${SCIM_PREFIX}${raw}`;
  return {
    plain,
    hash: createHash('sha256').update(plain).digest('hex'),
    prefix: raw.slice(0, 8),
  };
}

export function hashScimToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}
