// NOTE: pure module — safe to import from server actions, route handlers,
// and tests. No `'server-only'` because there are no side effects.
//
// `IdentityProvider.emailDomains` drives both the login-page IdP lookup and
// JIT provisioning's "is this email allowed in this org" check. Validation
// rules:
//
//   - Lowercase ASCII, RFC 1123 hostname syntax, ≥ 2 labels, no wildcards
//     (`*` is tempting for "all subdomains" but explodes the lookup logic
//     and isn't requested by any current customer).
//   - Top-level label must contain at least one letter — pure-numeric TLDs
//     don't exist (`acme.com` ✓, `acme.123` ✗).
//   - We do NOT validate that the org actually owns the domain — that's a
//     trust-the-OWNER decision; SSO config is OWNER/ADMIN-gated already.

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
 * Pull the domain part out of an email-shaped string. Returns null on
 * obviously-malformed input. We're deliberately not RFC 5321-strict here —
 * the IdP will refuse logins for genuinely bad emails, our job is just to
 * route the lookup.
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
