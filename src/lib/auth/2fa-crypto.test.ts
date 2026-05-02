/**
 * RFC 0002 PR-2 — 2FA 加密 / 备份码单测。
 *
 * encryptSecret / decryptSecret 形状与 webhook 那对镜像（同 HKDF + AES-256-GCM
 * 模式），但密文里装的是 TOTP 共享秘密 Buffer 不是 utf8 string。备份码部分则
 * 单独覆盖一次性使用 + Crockford 字母表 + dash 规范化。
 */

import { describe, expect, it } from 'vitest';

import {
  decryptSecret,
  encryptSecret,
  findBackupCodeHash,
  generateBackupCodes,
  hashBackupCode,
} from './2fa-crypto';

describe('encryptSecret / decryptSecret（TOTP 秘密）', () => {
  it('Buffer 往返恢复原始字节', () => {
    const plain = Buffer.from('SUPER_SECRET_TOTP_BYTES_20', 'utf8');
    const packed = encryptSecret('user-1', plain);
    expect(decryptSecret('user-1', packed).equals(plain)).toBe(true);
  });

  it('同 plaintext 每次加密 IV / 密文不同', () => {
    const plain = Buffer.from('AAAA');
    const a = encryptSecret('user-1', plain);
    const b = encryptSecret('user-1', plain);
    expect(a.equals(b)).toBe(false);
  });

  it('跨 userId 密钥隔离 — A 密文不能被 B 解开', () => {
    const plain = Buffer.from('shared');
    const packed = encryptSecret('user-a', plain);
    expect(() => decryptSecret('user-b', packed)).toThrow();
  });

  it('packed 太短 → throw encrypted-secret-too-short', () => {
    expect(() => decryptSecret('user-1', Buffer.alloc(10))).toThrow(/encrypted-secret-too-short/);
    expect(() => decryptSecret('user-1', Buffer.alloc(27))).toThrow(/encrypted-secret-too-short/);
  });

  it('篡改 tag → throw（GCM 认证失败）', () => {
    const packed = encryptSecret('user-1', Buffer.from('x'));
    const tampered = Buffer.from(packed);
    tampered[12] = (tampered[12]! ^ 0xff) & 0xff;
    expect(() => decryptSecret('user-1', tampered)).toThrow();
  });

  it('打包形状 = [12 字节 IV][16 字节 tag][密文]', () => {
    const packed = encryptSecret('user-1', Buffer.from('Z'));
    expect(packed.length).toBe(12 + 16 + 1);
  });
});

describe('generateBackupCodes', () => {
  it('返回 10 个 plain + 10 个 hash', () => {
    const { plain, hashes } = generateBackupCodes();
    expect(plain).toHaveLength(10);
    expect(hashes).toHaveLength(10);
  });

  it('plain 形如 XXXX-XXXX，全部 Crockford 字母表（无 0/O/1/I）', () => {
    const { plain } = generateBackupCodes();
    for (const code of plain) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
  });

  it('plain 之间 high-entropy（10 个互不重复）', () => {
    const { plain } = generateBackupCodes();
    expect(new Set(plain).size).toBe(plain.length);
  });

  it('hash[i] 与 hashBackupCode(plain[i]) 一致', () => {
    const { plain, hashes } = generateBackupCodes();
    for (let i = 0; i < plain.length; i++) {
      expect(hashes[i]).toBe(hashBackupCode(plain[i]!));
    }
  });
});

describe('hashBackupCode', () => {
  it('规范化：大小写 + 去除连字符后哈希一致', () => {
    expect(hashBackupCode('abcd-efgh')).toBe(hashBackupCode('ABCD-EFGH'));
    expect(hashBackupCode('abcdefgh')).toBe(hashBackupCode('ABCD-EFGH'));
    expect(hashBackupCode('AbCd-eFgH')).toBe(hashBackupCode('ABCDEFGH'));
  });

  it('确定性 sha256 hex（64 字符）', () => {
    expect(hashBackupCode('ABCD-EFGH')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('findBackupCodeHash', () => {
  const { plain, hashes } = generateBackupCodes();
  const validInput = plain[0]!;
  const validHash = hashes[0]!;

  it('合法输入命中 → 返回对应哈希（caller 用来从数组里删）', () => {
    expect(findBackupCodeHash(validInput, hashes)).toBe(validHash);
  });

  it('合法输入但 hashes 数组里没有 → null', () => {
    const otherHashes = generateBackupCodes().hashes;
    expect(findBackupCodeHash(validInput, otherHashes)).toBeNull();
  });

  it('大小写 / dash 不影响匹配', () => {
    const noDash = validInput.replace('-', '');
    const lower = validInput.toLowerCase();
    expect(findBackupCodeHash(noDash, hashes)).toBe(validHash);
    expect(findBackupCodeHash(lower, hashes)).toBe(validHash);
  });

  it.each(['', '   ', 'has spaces', 'illegal!chars', 'a'.repeat(33)])(
    '非法格式输入 "%s" → null（早 return，不打 hash）',
    (input) => {
      expect(findBackupCodeHash(input, hashes)).toBeNull();
    },
  );
});
