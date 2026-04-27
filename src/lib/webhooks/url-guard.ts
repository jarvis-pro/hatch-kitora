/**
 * RFC 0003 PR-1 —— 端点 URL 的 SSRF 防护。
 *
 * 保护 worker（PR-2）免受被欺骗以击中内部服务。
 * 我们在端点创建时进行验证，以便用户在 UI 中获得
 * 立即的、可操作的错误；cron 也在每次交付前重新检查
 * （纵深防御，以防 DNS 更改）。
 *
 * 规则：
 *   1. 必须是 `https:`（或 `http:` 如果为本地开发明确允许）。
 *   2. 主机名不能解析为 / 是字面量：
 *        - 私有 RFC1918（10/8、172.16/12、192.168/16）
 *        - 链路本地（169.254/16）—— 包括 AWS / GCP 元数据 IP
 *        - 环回（127/8）
 *        - IPv6 fc00::/7、::1、fe80::/10
 *   3. 按名称阻止已知的云元数据端点（最佳努力）。
 *
 * DNS 解析在验证时被故意跳过 —— DNS 重新绑定是真实的
 * 攻击，但在这里进行同步解析很脆弱（DNS 可以在此检查和
 * 交付之间更改）。cron 在 fetch 前进行自己的解析。
 */

/**
 * 被阻止的主机名列表。
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  // AWS / GCP / Azure / Hetzner 元数据端点（按主机名众所周知）。
  'metadata.google.internal',
  'metadata.azure.com',
]);

/**
 * 私有 IPv4 CIDR 范围列表。格式为 [a, b, c, d, prefix]。
 */
const PRIVATE_IPV4_RANGES: ReadonlyArray<[number, number, number, number, number]> = [
  // [a, b, c, d, prefix]
  [10, 0, 0, 0, 8],
  [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12],
  [192, 168, 0, 0, 16],
  [0, 0, 0, 0, 8],
];

/**
 * 检查 IPv4 地址是否在 CIDR 范围内。
 * @param ip - IPv4 地址。
 * @param cidr - CIDR 范围。
 * @returns 是否在范围内。
 */
function ipv4InCidr(ip: string, cidr: readonly [number, number, number, number, number]): boolean {
  const parts = ip.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const a = (parts[0]! << 24) >>> 0;
  const b = (parts[1]! << 16) >>> 0;
  const c = (parts[2]! << 8) >>> 0;
  const d = parts[3]! >>> 0;
  const ipNum = (a | b | c | d) >>> 0;
  const cidrA = (cidr[0] << 24) >>> 0;
  const cidrB = (cidr[1] << 16) >>> 0;
  const cidrC = (cidr[2] << 8) >>> 0;
  const cidrD = cidr[3] >>> 0;
  const cidrNum = (cidrA | cidrB | cidrC | cidrD) >>> 0;
  const mask = cidr[4] === 0 ? 0 : (0xffffffff << (32 - cidr[4])) >>> 0;
  return (ipNum & mask) === (cidrNum & mask);
}

/**
 * webhook URL 验证结果。
 */
export type WebhookUrlVerdict =
  | { ok: true; url: URL }
  | { ok: false; reason: 'invalid-url' | 'bad-protocol' | 'blocked-host' };

/**
 * 验证 webhook URL 的安全性。
 * @param raw - 原始 URL 字符串。
 * @param opts - 验证选项。
 * @returns 验证结果。
 */
export function validateWebhookUrl(
  raw: string,
  opts: { allowHttp?: boolean } = {},
): WebhookUrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) {
    return { ok: false, reason: 'bad-protocol' };
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: 'blocked-host' };
  }
  // IPv4 字面量——应用 CIDR 禁用列表。
  if (/^[\d.]+$/.test(host)) {
    for (const cidr of PRIVATE_IPV4_RANGES) {
      if (ipv4InCidr(host, cidr)) {
        return { ok: false, reason: 'blocked-host' };
      }
    }
  }
  // IPv6 字面量 —— 阻止环回（`[::1]`）、链路本地（`[fe80::*]`）、
  // ULA（`[fc00::*]` / `[fd00::*]`）。更复杂的任何东西超出
  // v1 范围；cron 端解析将捕获其余的。
  if (host.startsWith('[') || host.includes(':')) {
    if (host === '::1' || host === '[::1]') return { ok: false, reason: 'blocked-host' };
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
      return { ok: false, reason: 'blocked-host' };
    }
  }
  return { ok: true, url };
}
