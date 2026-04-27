import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 0002 PR-2 — 纯 TOTP / base32 帮助程序。
 *
 * 从 `2fa-crypto.ts` 分出，因为该模块的加密部分依赖 `env.AUTH_SECRET`
 * （仅服务器），但测试需要对照已知秘密计算码而无需拉入整个模块图。
 * 这里的任何内容都不触及数据库或环境变量。
 */

// ─── Base32（RFC 4648）──────────────────────────────────────────────────────

/**
 * Base32 字符集。
 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * 将缓冲区编码为 Base32 字符串。
 * @param buf - 输入缓冲区。
 * @returns Base32 编码的字符串。
 */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * 将 Base32 字符串解码为缓冲区。
 * @param s - Base32 编码的字符串。
 * @returns 解码后的缓冲区。
 * @throws 如果字符串包含无效的 Base32 字符。
 */
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid-base32-char');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ─── TOTP（RFC 6238 / RFC 4226）────────────────────────────────────────────

/**
 * TOTP 代码位数。
 */
const TOTP_DIGITS = 6;

/**
 * TOTP 时间步长（秒）。
 */
const TOTP_PERIOD = 30;

/**
 * 生成新的 20 字节 TOTP 秘密。
 * @returns 生成的秘密缓冲区。
 */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

/**
 * 计算给定计数器的 HOTP 码（用于 TOTP 验证和测试）。
 * @param secret - TOTP 秘密。
 * @param counter - HMAC 计数器。
 * @returns HOTP 码。
 */
function hotp(secret: Buffer, counter: bigint): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter);
  const mac = createHmac('sha1', secret).update(counterBuf).digest();
  // SHA-1 摘要总是 20 字节 —— 这些访问在范围内；断言以满足 noUncheckedIndexedAccess。
  const offset = mac[mac.length - 1]! & 0x0f;
  const truncated =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  const code = truncated % 10 ** TOTP_DIGITS;
  return code.toString().padStart(TOTP_DIGITS, '0');
}

/**
 * 计算秘密的当前 TOTP 码。对测试和开发工具有用。
 * @param secret - TOTP 秘密。
 * @param now - 当前时间戳（毫秒）；默认为 Date.now()。
 * @returns 当前 TOTP 码。
 */
export function totpNow(secret: Buffer, now = Date.now()): string {
  const counter = BigInt(Math.floor(now / 1000 / TOTP_PERIOD));
  return hotp(secret, counter);
}

/**
 * 用 ±1 步窗口验证 6 位 TOTP 码。匹配时返回 true。
 * 按步进行恒定时间字符串比较以避免泄露哪个步匹配。
 * @param secret - TOTP 秘密。
 * @param code - 要验证的 6 位 TOTP 码。
 * @param now - 当前时间戳（毫秒）；默认为 Date.now()。
 * @returns 码是否有效。
 */
export function verifyTotp(secret: Buffer, code: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = BigInt(Math.floor(now / 1000 / TOTP_PERIOD));
  for (const offset of [0n, -1n, 1n]) {
    const expected = hotp(secret, counter + offset);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(code, 'utf8');
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return true;
    }
  }
  return false;
}

/**
 * 为验证者 URI 构建标签（otpauth://totp/label）。
 * 格式：accountLabel（`user@example.com`）或 issuer:accountLabel。
 * @param accountLabel - 账户标签。
 * @param issuer - 可选的发行者名称。
 * @returns 标签字符串。
 */
function buildLabel(accountLabel: string, issuer?: string): string {
  if (issuer) {
    return `${issuer}:${accountLabel}`;
  }
  return accountLabel;
}

/**
 * 生成 otpauth:// URI（用于二维码或手动输入）。
 * 格式符合 RFC 6238（带有可选的 issuer 参数）。
 * @param opts - 生成选项。
 * @returns otpauth URI 字符串。
 */
export function buildOtpauthUri(opts: {
  secret: Buffer;
  accountLabel: string;
  issuer?: string;
}): string {
  const label = buildLabel(opts.accountLabel, opts.issuer);
  const params = new URLSearchParams({
    secret: base32Encode(opts.secret),
    issuer: opts.issuer || '',
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
