// 注意：纯模块 — 可以安全地从 server action、route handler 和测试导入。
// 没有 'server-only' 因为没有副作用。
//
// `IdentityProvider.emailDomains` 驱动登录页面 IdP 查询和 JIT
// 配置的"此电子邮件是否允许在此 org 中"检查。验证规则：
//
//   - 小写 ASCII、RFC 1123 主机名语法、≥ 2 个标签、无通配符
//     （`*` 对"所有子域"很诱人但会爆炸查询逻辑
//     并且任何当前客户都没有要求）。
//   - 顶级标签必须至少包含一个字母 — 纯数字 TLD
//     不存在（`acme.com` ✓、`acme.123` ✗）。
//   - 我们*不*验证 org 是否实际拥有域 — 这是
//     信任 OWNER 的决定；SSO 配置已是 OWNER/ADMIN 把守。

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const HAS_LETTER = /[a-z]/;

export type DomainVerdict =
  | { ok: true; domain: string }
  | { ok: false; reason: 'empty' | 'too-long' | 'invalid-format' | 'numeric-tld' | 'wildcard' };

export function validateEmailDomain(input: string): DomainVerdict {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > 253) return { ok: false, reason: 'too-long' };
  if (trimmed.includes('*')) return { ok: false, reason: 'wildcard' };
  if (!HOSTNAME.test(trimmed)) return { ok: false, reason: 'invalid-format' };
  const tld = trimmed.split('.').pop()!;
  if (!HAS_LETTER.test(tld)) return { ok: false, reason: 'numeric-tld' };
  return { ok: true, domain: trimmed };
}

/**
 * 从电子邮件形状的字符串中拉出域部分。返回 null
 * 明显格式错误的输入。我们这里刻意不是 RFC 5321 严格 —
 * IdP 会拒绝真正坏的电子邮件登录，我们的工作只是路由查询。
 */
export function extractDomainFromEmail(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain.length > 0 ? domain : null;
}
