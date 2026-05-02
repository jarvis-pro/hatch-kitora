/**
 * RFC 0002 PR-2 — 纯 TOTP / base32 单测。
 *
 * 用 RFC 6238 标准已知向量验证 TOTP 实现是否符合规范 —— 任何 regression 都会
 * 让所有用户的 2FA 登录同时失败。覆盖：
 *   - base32 编解码已知向量（与 RFC 4648 兼容子集）+ 往返 + 大小写/空白/padding 容错 + 非法字符抛错
 *   - hotp/totpNow 用 RFC 6238 secret '12345678901234567890' 在 5 个时间点上对齐
 *   - verifyTotp ±1 步窗口（前一步 / 当前 / 后一步全过，更远拒）
 *   - 非 6 位数字格式拒
 *   - generateTotpSecret 20 字节 + 高熵
 *   - buildOtpauthUri 形态：带 issuer / 不带 issuer / 固定参数
 */

import { describe, expect, it } from 'vitest';

import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  totpNow,
  verifyTotp,
} from './2fa-totp';

describe('base32Encode', () => {
  // 注意：本实现不输出 RFC 4648 的 `=` padding —— 与 RFC 6238 otpauth 兼容
  // （二维码扫描器会忽略 padding），但与 `node:buffer` 的 base64 系列不同。
  // 解码侧显式 `replace(/=+$/, '')` 容忍带 padding 的输入。
  it.each<[string, string]>([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foobar', 'MZXW6YTBOI'],
  ])('编码 "%s" → "%s"（RFC 4648 已知向量）', (input, expected) => {
    expect(base32Encode(Buffer.from(input))).toBe(expected);
  });
});

describe('base32Decode', () => {
  it.each<[string, string]>([
    ['', ''],
    ['MY', 'f'],
    ['MZXQ', 'fo'],
    ['MZXW6', 'foo'],
    ['MZXW6YTBOI', 'foobar'],
  ])('解码 "%s" → "%s"', (input, expected) => {
    expect(base32Decode(input).toString('utf8')).toBe(expected);
  });

  it('忽略 padding =', () => {
    expect(base32Decode('MZXW6YTBOI======').toString('utf8')).toBe('foobar');
  });

  it('忽略空白', () => {
    expect(base32Decode('MZXW 6YTB OI').toString('utf8')).toBe('foobar');
  });

  it('忽略大小写', () => {
    expect(base32Decode('mzxw6ytboi').toString('utf8')).toBe('foobar');
  });

  it('非法字符抛 invalid-base32-char', () => {
    expect(() => base32Decode('M!XW6')).toThrow(/invalid-base32-char/);
    // base32 字母表不包含 0/1/8/9（容易与 O/I/B 混淆）
    expect(() => base32Decode('M0XW6')).toThrow(/invalid-base32-char/);
    expect(() => base32Decode('M1XW6')).toThrow(/invalid-base32-char/);
  });

  it('编码 → 解码往返恢复原始 bytes（任意 binary）', () => {
    const buf = Buffer.from([0x00, 0xff, 0x42, 0x13, 0x37, 0xab, 0xcd, 0xef]);
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });
});

describe('totpNow / hotp（RFC 6238 已知向量）', () => {
  // RFC 6238 测试向量：secret = ASCII "12345678901234567890"
  // 时间步长 30s，6 位 TOTP（注意 RFC 6238 附录 B 是 8 位，需重算 6 位）。
  const SECRET = Buffer.from('12345678901234567890');

  it.each<[number, string]>([
    [59 * 1000, '287082'],
    [1111111109 * 1000, '081804'],
    [1111111111 * 1000, '050471'],
    [1234567890 * 1000, '005924'],
    [2000000000 * 1000, '279037'],
  ])('T=%i ms → %s', (nowMs, expected) => {
    expect(totpNow(SECRET, nowMs)).toBe(expected);
  });

  it('返回的码永远是 6 位数字（前导 0 补齐）', () => {
    const buf = Buffer.alloc(20);
    for (let i = 0; i < 100; i++) {
      const code = totpNow(buf, i * 30_000);
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});

describe('verifyTotp', () => {
  const SECRET = Buffer.from('12345678901234567890');
  const NOW = 1111111111 * 1000;
  const CURRENT_CODE = '050471';
  const PREV_CODE = '081804'; // T=1111111109 同窗口
  const NEXT_CODE = totpNow(SECRET, NOW + 30_000);

  it('当前步的码通过', () => {
    expect(verifyTotp(SECRET, CURRENT_CODE, NOW)).toBe(true);
  });

  it('前一步（-30s）的码通过 — 容忍时钟漂移 / 用户输入慢', () => {
    expect(verifyTotp(SECRET, PREV_CODE, NOW)).toBe(true);
  });

  it('后一步（+30s）的码通过 — 容忍时钟漂移', () => {
    expect(verifyTotp(SECRET, NEXT_CODE, NOW)).toBe(true);
  });

  it('远超窗口（-2 / +2 步以上）拒', () => {
    const farPast = totpNow(SECRET, NOW - 60_000);
    const farFuture = totpNow(SECRET, NOW + 60_000);
    expect(verifyTotp(SECRET, farPast, NOW)).toBe(false);
    expect(verifyTotp(SECRET, farFuture, NOW)).toBe(false);
  });

  it('错码拒', () => {
    expect(verifyTotp(SECRET, '000000', NOW)).toBe(false);
    expect(verifyTotp(SECRET, '999999', NOW)).toBe(false);
  });

  it.each(['12345', '1234567', 'abcdef', '12 345', '', '12345 '])(
    '非 6 位数字格式 "%s" → false',
    (code) => {
      expect(verifyTotp(SECRET, code, NOW)).toBe(false);
    },
  );

  it('错 secret 拒（即使码本身格式合法）', () => {
    const otherSecret = Buffer.from('XXXXXXXXXXXXXXXXXXXX');
    expect(verifyTotp(otherSecret, CURRENT_CODE, NOW)).toBe(false);
  });
});

describe('generateTotpSecret', () => {
  it('返回 20 字节（160 bit，RFC 4226 推荐 ≥160 bit）', () => {
    expect(generateTotpSecret().length).toBe(20);
  });

  it('两次生成不重复（high-entropy）', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a.equals(b)).toBe(false);
  });
});

describe('buildOtpauthUri', () => {
  const SECRET = Buffer.from('12345678901234567890');

  it('不带 issuer：otpauth://totp/<accountLabel>?secret=...', () => {
    const uri = buildOtpauthUri({ secret: SECRET, accountLabel: 'alice@acme.com' });
    expect(uri.startsWith('otpauth://totp/alice@acme.com?')).toBe(true);
    expect(uri).toContain('secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('带 issuer：otpauth://totp/<issuer>:<accountLabel>?secret=...&issuer=...', () => {
    const uri = buildOtpauthUri({
      secret: SECRET,
      accountLabel: 'alice@acme.com',
      issuer: 'Kitora',
    });
    expect(uri.startsWith('otpauth://totp/Kitora:alice@acme.com?')).toBe(true);
    expect(uri).toContain('issuer=Kitora');
  });

  it('secret 字段是 base32(secret) 不是 base64', () => {
    const uri = buildOtpauthUri({ secret: SECRET, accountLabel: 'a' });
    const m = /secret=([A-Z2-7]+)/.exec(uri);
    expect(m).not.toBeNull();
    if (m) {
      expect(base32Decode(m[1]!).equals(SECRET)).toBe(true);
    }
  });
});
