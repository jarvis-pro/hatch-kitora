# Kitora REST API — Integration guide

This directory holds the source-of-truth OpenAPI spec for the Kitora public API
(`openapi/v1.yaml`) plus integrator-facing examples. The spec is rendered
in-product at `/docs/api` (Scalar) and served raw at `/api/openapi/v1.yaml`.

The contract is **handwritten**, not generated. When you add a public endpoint
under `src/app/api/v1/**/route.ts`, you must mirror it into `v1.yaml` in the
same PR. CI runs two cross-checks:

```bash
pnpm openapi:lint       # @redocly/cli — schema-level lint
pnpm openapi:check      # scripts/check-openapi-coverage.ts — paths × routes diff
```

Both must pass before merge.

## Why handwritten

A SaaS template's public API is a stability promise to integrators — a contract
that should change more slowly than the code. Generating spec from code couples
them too tightly: a stray `.optional()` in a Zod schema becomes a backwards-
incompatible spec change. We trade a bit of duplication for a lot of intent.

The coverage script catches the most common drift (route added, spec
forgotten); the lint job catches the rest (typos, dangling refs, broken
example shapes).

## Webhook signing

Outbound webhook deliveries from Kitora carry an HMAC-SHA256 signature in the
`X-Kitora-Signature` header. The format is:

```
X-Kitora-Signature: t=<unix_ts>,v1=<hex_sha256>
```

where the signed payload is `<unix_ts>.<raw_request_body>`. Receivers MUST
do two things:

1. **Verify the signature** — recompute `hex(HMAC_SHA256(secret, ts + "." + body))`
   with the **raw** request bytes (no JSON re-serialization) and constant-time
   compare against `v1`.
2. **Enforce a 5-minute timestamp window** — reject the request if `|now - t| > 300`,
   to prevent replay of captured deliveries.

Sample receiver code in three languages — pick the one that matches your stack
and inline it. The `examples/` folder has full runnable copies.

### Node.js (Next.js / Express)

```js
import crypto from 'node:crypto';

const MAX_AGE = 300; // 5 minutes

export function verifyKitoraSignature({ header, body, secret, now = Date.now() / 1000 }) {
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
```

### Python (FastAPI / Flask)

```python
import hmac
import hashlib
import time

MAX_AGE = 300

def verify_kitora_signature(*, header: str, body: bytes, secret: str, now: float | None = None) -> bool:
    now = time.time() if now is None else now
    parts = dict(p.strip().split('=', 1) for p in header.split(',') if '=' in p)
    try:
        t = int(parts['t'])
    except (KeyError, ValueError):
        return False
    if abs(now - t) > MAX_AGE:
        return False
    signed_payload = f"{t}.".encode() + body
    expected = hmac.new(secret.encode(), signed_payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get('v1', ''))
```

### PHP (Laravel / Symfony / vanilla)

```php
function verifyKitoraSignature(string $header, string $body, string $secret): bool {
    $maxAge = 300;
    $parts = [];
    foreach (explode(',', $header) as $pair) {
        [$k, $v] = array_map('trim', explode('=', $pair, 2)) + [null, null];
        if ($k && $v) $parts[$k] = $v;
    }
    if (!isset($parts['t'], $parts['v1'])) return false;
    $t = (int) $parts['t'];
    if (abs(time() - $t) > $maxAge) return false;
    $expected = hash_hmac('sha256', $t . '.' . $body, $secret);
    return hash_equals($expected, $parts['v1']);
}
```

## Headers Kitora sends with every delivery

| Header                | Description                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `X-Kitora-Event-Id`   | Logical event id, stable across retries. Use this for receiver-side idempotency.             |
| `X-Kitora-Event-Type` | E.g. `subscription.created`. See `WebhookEventType` in the spec for the full registry.       |
| `X-Kitora-Timestamp`  | Epoch seconds the delivery was attempted (echo of the `t=` portion of the signature).        |
| `X-Kitora-Signature`  | `t=<ts>,v1=<hex_sha256>` — see above for verification.                                       |
| `User-Agent`          | `Kitora-Webhooks/1.0` — pin this in your firewall allow-list if you want stricter filtering. |
| `Content-Type`        | `application/json`                                                                           |

## Idempotency

Use `X-Kitora-Event-Id` as your dedupe key. The cron worker will retry a
delivery up to 8 times over ~44 hours; each attempt has the **same** event
id but a different signature timestamp. Don't dedupe on the signature, the
delivery row id, or the body hash — those all change across retries.

## Rate limits on the management API

The `/api/v1/orgs/{slug}/webhooks*` management endpoints share the same
per-token rate limiter as the rest of the API. Inspect the
`X-RateLimit-Remaining` / `X-RateLimit-Reset` headers on every response. A
429 means the bucket is empty until the reset epoch.

There is **no** separate rate limit on incoming deliveries to your endpoint —
that's between you and your reverse proxy.
