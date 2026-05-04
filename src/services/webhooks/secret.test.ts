/**
 * RFC 0003 PR-1 / PR-2 — webhook secret 加密 / 哈希单测。
 *
 * 这是出站 webhook HMAC 链路的根：cron 每次投递前都要 decryptSecret 取明文
 * 来重算签名，一旦解密链路有 regression（密钥派生 / IV 错位 / 截断处理）就
 * 会让所有出站 webhook 同时失败。覆盖：
 *   - generateWebhookSecret 形状（whsec_ 前缀 + base64url 32 字节正文 + 8 字符 prefix + sha256 hash）
 *   - encryptSecret + decryptSecret 自洽
 *   - 不同 endpointId 的密钥隔离（A 加密的密文不能被 B 解开）
 *   - 同明文每次加密 IV 不同（避免 GCM 同 nonce 灾难）
 *   - 篡改密文 / tag → throw（GCM 认证）
 *   - packed 太短 → throw 'webhook-secret-too-short'
 *   - hashWebhookSecret 与 generateWebhookSecret.hash 一致
 */

import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret, generateWebhookSecret, hashWebhookSecret } from './secret';

describe('generateWebhookSecret', () => {
  it('plain 以 whsec_ 开头', () => {
    const s = generateWebhookSecret();
    expect(s.plain.startsWith('whsec_')).toBe(true);
  });

  it('正文是 base64url 32 字节（约 43 字符）', () => {
    const s = generateWebhookSecret();
    const body = s.plain.slice('whsec_'.length);
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.length).toBeGreaterThanOrEqual(40);
  });

  it('prefix 是正文前 8 字符', () => {
    const s = generateWebhookSecret();
    const body = s.plain.slice('whsec_'.length);
    expect(s.prefix).toBe(body.slice(0, 8));
  });

  it('hash 是 plain 的 sha256（与 hashWebhookSecret 一致）', () => {
    const s = generateWebhookSecret();
    expect(s.hash).toBe(hashWebhookSecret(s.plain));
  });

  it('encryptForEndpoint 闭包能与 decryptSecret 往返', () => {
    const s = generateWebhookSecret();
    const packed = s.encryptForEndpoint('endpoint-1');
    expect(decryptSecret('endpoint-1', packed)).toBe(s.plain);
  });

  it('两次调用产出不同的 plain（high-entropy）', () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a.plain).not.toBe(b.plain);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('encryptSecret + decryptSecret 自洽', () => {
  it('往返恢复明文', () => {
    const plain = 'whsec_test_payload_12345';
    const packed = encryptSecret('ep_1', plain);
    expect(decryptSecret('ep_1', packed)).toBe(plain);
  });

  it('同明文每次加密 IV / 密文不同（防 GCM 同 nonce）', () => {
    const plain = 'whsec_constant';
    const a = encryptSecret('ep_1', plain);
    const b = encryptSecret('ep_1', plain);
    expect(a.equals(b)).toBe(false);
    // 解密都能恢复
    expect(decryptSecret('ep_1', a)).toBe(plain);
    expect(decryptSecret('ep_1', b)).toBe(plain);
  });

  it('密文打包形状 = [12 字节 IV][16 字节 tag][密文]', () => {
    const plain = 'a';
    const packed = encryptSecret('ep_1', plain);
    // 12 + 16 + 1（'a' 的 utf8 字节数）= 29
    expect(packed.length).toBe(29);
  });
});

describe('encryptSecret 跨 endpointId 隔离', () => {
  it('A 加密的密文不能被 B 解开（密钥派生隔离）', () => {
    const plain = 'whsec_secret_for_a';
    const packed = encryptSecret('ep_a', plain);
    expect(() => decryptSecret('ep_b', packed)).toThrow();
  });

  it('A / B 加密同明文，得到的密文也不同（不同密钥）', () => {
    const plain = 'whsec_x';
    const a = encryptSecret('ep_a', plain);
    const b = encryptSecret('ep_b', plain);
    expect(a.equals(b)).toBe(false);
  });
});

describe('decryptSecret 防御性检查', () => {
  it('packed 比 IV+tag 还短 → throw webhook-secret-too-short', () => {
    expect(() => decryptSecret('ep_1', Buffer.alloc(10))).toThrow(/webhook-secret-too-short/);
    expect(() => decryptSecret('ep_1', Buffer.alloc(27))).toThrow(/webhook-secret-too-short/);
  });

  it('篡改 tag（中段 16 字节）→ throw（GCM 认证失败）', () => {
    const packed = encryptSecret('ep_1', 'whsec_x');
    const tampered = Buffer.from(packed);
    tampered[12] = (tampered[12]! ^ 0xff) & 0xff; // 翻 tag 第 1 字节
    expect(() => decryptSecret('ep_1', tampered)).toThrow();
  });

  it('篡改密文（最后一字节）→ throw（GCM 认证失败）', () => {
    const packed = encryptSecret('ep_1', 'whsec_xyz');
    const tampered = Buffer.from(packed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff;
    expect(() => decryptSecret('ep_1', tampered)).toThrow();
  });
});

describe('hashWebhookSecret', () => {
  it('确定性 sha256 hex（64 字符）', () => {
    expect(hashWebhookSecret('whsec_x')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashWebhookSecret('whsec_x')).toBe(hashWebhookSecret('whsec_x'));
  });

  it('不同输入产出不同哈希', () => {
    expect(hashWebhookSecret('a')).not.toBe(hashWebhookSecret('b'));
  });
});
