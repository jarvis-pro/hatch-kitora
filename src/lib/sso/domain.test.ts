/**
 * RFC 0004 — SSO email domain 校验单测。
 *
 * `IdentityProvider.emailDomains` 驱动登录页 IdP 查询 + JIT 配置时的「这个邮箱
 * 允不允许进这个 org」判断 —— 域名格式没拦住的话，OWNER 输入 `*.com` 就会把全
 * 互联网都纳进白名单。
 */

import { describe, expect, it } from 'vitest';

import { extractDomainFromEmail, validateEmailDomain } from './domain';

describe('validateEmailDomain', () => {
  describe('合法域名', () => {
    it.each(['acme.com', 'acme.co.uk', 'sub.example.org', 'a.b'])('%s 通过', (input) => {
      const v = validateEmailDomain(input);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.domain).toBe(input.toLowerCase());
    });

    it('大写 / 周围空白 → 规范化为 lowercase + trim', () => {
      const v = validateEmailDomain('  ACME.COM  ');
      expect(v).toEqual({ ok: true, domain: 'acme.com' });
    });
  });

  describe('非法域名', () => {
    it('空串 → empty', () => {
      expect(validateEmailDomain('').ok).toBe(false);
      expect(validateEmailDomain('   ').ok).toBe(false);
    });

    it('超长（> 253 char）→ too-long', () => {
      const v = validateEmailDomain('a'.repeat(254) + '.com');
      expect(v).toEqual({ ok: false, reason: 'too-long' });
    });

    it('含通配符 → wildcard（不允许 *.com 这种粗放白名单）', () => {
      expect(validateEmailDomain('*.acme.com')).toEqual({ ok: false, reason: 'wildcard' });
    });

    it.each(['acme', 'acme.', '.acme.com', 'acme..com', '-bad.com', 'has space.com'])(
      '%s → invalid-format',
      (input) => {
        const v = validateEmailDomain(input);
        expect(v.ok).toBe(false);
        if (!v.ok) expect(v.reason).toBe('invalid-format');
      },
    );

    it('纯数字 TLD（acme.123）→ numeric-tld', () => {
      expect(validateEmailDomain('acme.123')).toEqual({ ok: false, reason: 'numeric-tld' });
    });
  });
});

describe('extractDomainFromEmail', () => {
  it.each([
    ['alice@acme.com', 'acme.com'],
    ['ALICE@ACME.COM', 'acme.com'],
    ['  bob@example.org  ', 'example.org'],
    ['multi@with@signs.com', 'signs.com'], // 取最后一个 @
  ])('%s → %s', (input, expected) => {
    expect(extractDomainFromEmail(input)).toBe(expected);
  });

  it.each(['', 'no-at-sign', '@nolocal.com', 'noremote@', 'plain'])('%s → null', (input) => {
    expect(extractDomainFromEmail(input)).toBeNull();
  });
});
