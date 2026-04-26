// Runnable Node.js example: drop into a Next.js API route or an Express handler.
// Verifies the X-Kitora-Signature header + replay window in ~25 lines.
//
// Run as a smoke test:
//   node openapi/examples/verify-node.js
import crypto from 'node:crypto';

const MAX_AGE = 300; // 5 minutes — must match Kitora's window

export function verifyKitoraSignature({
  header,
  body,
  secret,
  now = Math.floor(Date.now() / 1000),
}) {
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1)];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t)) return false;
  if (Math.abs(now - t) > MAX_AGE) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parts.v1 ?? '', 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── Smoke test ──────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ id: 'evt_1', type: 'subscription.created' });
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const header = `t=${t},v1=${v1}`;
  console.log(verifyKitoraSignature({ header, body, secret }) ? 'OK' : 'FAIL');
}
