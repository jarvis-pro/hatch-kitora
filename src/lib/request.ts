import { headers } from 'next/headers';

/**
 * Resolve the client IP from common proxy headers, falling back to "unknown".
 *
 * Calls outside a Next.js request scope (e.g. inside a test that drives a
 * server action / `recordAudit` directly) make `headers()` throw. We swallow
 * that case and return `'unknown'` so callers in test contexts still get a
 * usable string instead of the audit insert blowing up.
 */
export async function getClientIp(): Promise<string> {
  try {
    const h = await headers();
    return (
      h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      h.get('x-real-ip') ??
      h.get('cf-connecting-ip') ??
      'unknown'
    );
  } catch {
    return 'unknown';
  }
}
