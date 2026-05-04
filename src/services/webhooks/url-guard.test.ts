/**
 * RFC 0003 PR-1 — webhook URL SSRF 防护单测。
 *
 * 这道防线挡 webhook 端点配置时的 SSRF：用户填一个 http://169.254.169.254/...
 * 想读云元数据，validateWebhookUrl 应该当场拒。cron worker 在每次投递前会再
 * 重新跑一次（防 DNS 重新绑定），所以这里只测语法 / CIDR 静态判断。
 */

import { describe, expect, it } from 'vitest';

import { validateWebhookUrl } from './url-guard';

describe('validateWebhookUrl', () => {
  describe('合法 URL', () => {
    it('https 公网域名通过', () => {
      expect(validateWebhookUrl('https://hooks.example.com/webhook').ok).toBe(true);
    });
    it('https + 端口 + 路径 + query 通过', () => {
      expect(validateWebhookUrl('https://api.acme.io:8443/v1/hook?token=abc').ok).toBe(true);
    });
    it('http 在显式 allowHttp 时通过（本地开发场景）', () => {
      expect(validateWebhookUrl('http://hooks.example.com/x', { allowHttp: true }).ok).toBe(true);
    });
  });

  describe('协议禁用', () => {
    it('裸 http 默认拒（生产路径）', () => {
      const v = validateWebhookUrl('http://hooks.example.com/');
      expect(v).toEqual({ ok: false, reason: 'bad-protocol' });
    });
    it.each(['ftp://x.com', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,hi'])(
      '%s 拒',
      (url) => {
        expect(validateWebhookUrl(url).ok).toBe(false);
      },
    );
  });

  describe('URL 解析失败', () => {
    it.each(['', 'not a url', 'http://', '://nohost'])('%s → invalid-url', (url) => {
      const v = validateWebhookUrl(url);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe('invalid-url');
    });
  });

  describe('黑名单主机名', () => {
    it.each([
      'https://localhost/x',
      'https://metadata.google.internal/',
      'https://metadata.azure.com/',
    ])('%s → blocked-host', (url) => {
      const v = validateWebhookUrl(url);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe('blocked-host');
    });
  });

  describe('私有 IPv4 CIDR', () => {
    it.each([
      'https://10.0.0.1/x', // 10/8
      'https://10.255.255.255/x',
      'https://127.0.0.1/x', // 127/8 loopback
      'https://169.254.169.254/x', // AWS / GCP metadata
      'https://172.16.0.1/x', // 172.16/12
      'https://172.31.255.254/x', // 172.16/12 上界
      'https://192.168.1.1/x', // 192.168/16
      'https://0.0.0.0/x', // 0.0.0.0/8
    ])('%s → blocked-host', (url) => {
      const v = validateWebhookUrl(url);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe('blocked-host');
    });

    it('公网 IP 通过（8.8.8.8）', () => {
      expect(validateWebhookUrl('https://8.8.8.8/').ok).toBe(true);
    });

    it('刚好在私有段外（172.32.0.1，172.16/12 边界外）通过', () => {
      expect(validateWebhookUrl('https://172.32.0.1/').ok).toBe(true);
    });
  });

  describe('IPv6 字面量', () => {
    it.each([
      'https://[::1]/x', // loopback
      'https://[fe80::1]/x', // link-local
      'https://[fc00::1]/x', // ULA
      'https://[fd00::1]/x', // ULA
    ])('%s → blocked-host', (url) => {
      const v = validateWebhookUrl(url);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe('blocked-host');
    });
  });
});
