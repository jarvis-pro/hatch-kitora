/**
 * RFC 0003 PR-1 — SSRF guard for endpoint URLs.
 *
 * Protects the worker (PR-2) from being tricked into hitting internal
 * services. We do the validation at endpoint *creation* time so the user
 * gets an immediate, actionable error in the UI; the cron also re-checks
 * before each delivery (defense-in-depth, in case DNS changes).
 *
 * Rules:
 *   1. Must be `https:` (or `http:` if explicitly allowed for localhost dev).
 *   2. Hostname must not resolve to / be a literal of:
 *        - private RFC1918 (10/8, 172.16/12, 192.168/16)
 *        - link-local (169.254/16) — incl. AWS / GCP metadata IPs
 *        - loopback (127/8)
 *        - IPv6 fc00::/7, ::1, fe80::/10
 *   3. Block known cloud metadata endpoints by name (best effort).
 *
 * DNS resolution is intentionally skipped at validation time — DNS rebinding
 * is a real attack but doing a sync resolve here is fragile (DNS can change
 * between this check and delivery). The cron does its own resolve right
 * before the fetch.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  // AWS / GCP / Azure / Hetzner metadata endpoints (well-known by hostname).
  'metadata.google.internal',
  'metadata.azure.com',
]);

const PRIVATE_IPV4_RANGES: ReadonlyArray<[number, number, number, number, number]> = [
  // [a, b, c, d, prefix]
  [10, 0, 0, 0, 8],
  [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12],
  [192, 168, 0, 0, 16],
  [0, 0, 0, 0, 8],
];

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

export type WebhookUrlVerdict =
  | { ok: true; url: URL }
  | { ok: false; reason: 'invalid-url' | 'bad-protocol' | 'blocked-host' };

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
  // IPv4 literal — apply CIDR ban list.
  if (/^[\d.]+$/.test(host)) {
    for (const cidr of PRIVATE_IPV4_RANGES) {
      if (ipv4InCidr(host, cidr)) {
        return { ok: false, reason: 'blocked-host' };
      }
    }
  }
  // IPv6 literal — block loopback (`[::1]`), link-local (`[fe80::*]`),
  // ULA (`[fc00::*]` / `[fd00::*]`). Anything more sophisticated falls
  // out of scope for v1; cron-side resolve will catch the rest.
  if (host.startsWith('[') || host.includes(':')) {
    if (host === '::1' || host === '[::1]') return { ok: false, reason: 'blocked-host' };
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
      return { ok: false, reason: 'blocked-host' };
    }
  }
  return { ok: true, url };
}
