/**
 * RFC 0003 PR-2 — webhook HMAC 签名 / 验签单测。
 *
 * 集成商按 `verifyWebhookSignature` 的 source 复制粘贴接入，所以这套测试既是
 * 内部回归保险，也是文档 example 的事实标准。覆盖：
 *   - 自洽（sign 出来的 header 必须能被 verify 通过）
 *   - 5 分钟重放窗口（默认 maxAge=300s）
 *   - body / secret 篡改后立即 bad-signature
 *   - 头格式损坏的几种典型形状
 *   - 长度不匹配走 bad-signature 而非崩溃
 */

import { describe, expect, it } from 'vitest';

import { signWebhookPayload, verifyWebhookSignature } from './sign';

const SECRET = 'whsec_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BODY = JSON.stringify({ event: 'subscription.created', orgId: 'o1' });

describe('signWebhookPayload', () => {
  it('返回 t=...,v1=... 的 Stripe 风格签名头', () => {
    const { signature, timestamp } = signWebhookPayload({
      secret: SECRET,
      body: BODY,
      timestamp: 1745723404,
    });
    expect(timestamp).toBe(1745723404);
    expect(signature).toMatch(/^t=1745723404,v1=[0-9a-f]{64}$/);
  });

  it('未传 timestamp 时使用当前纪元秒（数量级合理）', () => {
    const { timestamp } = signWebhookPayload({ secret: SECRET, body: BODY });
    const nowSec = Math.floor(Date.now() / 1000);
    expect(Math.abs(nowSec - timestamp)).toBeLessThan(5);
  });

  it('相同输入产出确定的 hex（HMAC 是确定性函数）', () => {
    const a = signWebhookPayload({ secret: SECRET, body: BODY, timestamp: 1 });
    const b = signWebhookPayload({ secret: SECRET, body: BODY, timestamp: 1 });
    expect(a.signature).toBe(b.signature);
  });
});

describe('verifyWebhookSignature 自洽', () => {
  it('sign + verify 在同一窗口内通过', () => {
    const ts = 1745723404;
    const { signature } = signWebhookPayload({ secret: SECRET, body: BODY, timestamp: ts });
    const v = verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      header: signature,
      now: ts + 60,
    });
    expect(v).toEqual({ ok: true });
  });

  it('header 有空格 / 顺序颠倒（v1 在前 t 在后）也接受', () => {
    const ts = 1745723404;
    const { signature } = signWebhookPayload({ secret: SECRET, body: BODY, timestamp: ts });
    const v1 = signature.split(',')[1]!;
    const swapped = `${v1}, t=${ts}`;
    expect(
      verifyWebhookSignature({ secret: SECRET, body: BODY, header: swapped, now: ts }),
    ).toEqual({
      ok: true,
    });
  });
});

describe('verifyWebhookSignature 拒绝路径', () => {
  const ts = 1745723404;
  const { signature } = signWebhookPayload({ secret: SECRET, body: BODY, timestamp: ts });

  it('body 篡改 → bad-signature', () => {
    const v = verifyWebhookSignature({
      secret: SECRET,
      body: BODY + ' tampered',
      header: signature,
      now: ts,
    });
    expect(v).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('secret 错误 → bad-signature', () => {
    const v = verifyWebhookSignature({
      secret: 'whsec_wrong',
      body: BODY,
      header: signature,
      now: ts,
    });
    expect(v).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('超过 5 分钟重放窗口 → expired', () => {
    const v = verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      header: signature,
      now: ts + 301,
    });
    expect(v).toEqual({ ok: false, reason: 'expired' });
  });

  it('未来时钟漂移超过窗口（now < t - 300）→ expired（双向保护）', () => {
    const v = verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      header: signature,
      now: ts - 301,
    });
    expect(v).toEqual({ ok: false, reason: 'expired' });
  });

  it('刚好在窗口边界（diff = 300s）→ 仍接受', () => {
    const v = verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      header: signature,
      now: ts + 300,
    });
    expect(v.ok).toBe(true);
  });

  it.each([
    'no-equals',
    't=,v1=',
    't=abc,v1=def', // t 不是数字
    'v1=only', // 缺 t
    't=123', // 缺 v1
    '',
  ])('损坏头 "%s" → malformed-header', (header) => {
    const v = verifyWebhookSignature({ secret: SECRET, body: BODY, header, now: ts });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('malformed-header');
  });

  it('v1 长度不匹配（短 hex）→ bad-signature 而非崩溃', () => {
    const v = verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      header: `t=${ts},v1=deadbeef`,
      now: ts,
    });
    expect(v).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('自定义 maxAgeSeconds 生效（窗口 60s 时 ts+61 即过期）', () => {
    const v = verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      header: signature,
      now: ts + 61,
      maxAgeSeconds: 60,
    });
    expect(v).toEqual({ ok: false, reason: 'expired' });
  });
});
