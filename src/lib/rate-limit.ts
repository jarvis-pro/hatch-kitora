import 'server-only';

import { Ratelimit } from '@upstash/ratelimit';
import { Redis as UpstashRedis } from '@upstash/redis';
import type { Redis as IoRedisType } from 'ioredis';

import { env } from '@/env';
import { isCnRegion } from '@/lib/region';

type Limiter = {
  limit: (
    key: string,
  ) => Promise<{ success: boolean; remaining: number; limit: number; reset: number }>;
};

function noopLimiter(): Limiter {
  return {
    async limit() {
      return { success: true, remaining: Infinity, limit: Infinity, reset: 0 };
    },
  };
}

// ─── Window parsing (shared between Upstash + Aliyun branches) ─────────────

const WINDOW_UNIT_MS: Record<'s' | 'm' | 'h', number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

function parseWindowMs(window: `${number} ${'s' | 'm' | 'h'}`): number {
  const [n, unit] = window.split(' ') as [string, 's' | 'm' | 'h'];
  return Number(n) * WINDOW_UNIT_MS[unit];
}

// ─── Aliyun Redis branch (RFC 0006 PR-4) ───────────────────────────────────
//
// CN region uses ioredis (TCP) against an Aliyun Redis instance — Upstash
// REST is on the wrong side of the GFW for hot-path rate-limit checks
// (≥200ms RTT, way above the 5ms budget). Sliding window is hand-rolled
// because @upstash/ratelimit's limiter abstraction expects an Upstash
// Redis interface that wraps REST semantics; bridging it is more code
// than just doing the algorithm in 3 Redis ops.
//
// Algorithm (sorted-set window):
//   1. ZREMRANGEBYSCORE — drop entries older than `now - windowMs`.
//   2. ZCARD            — count remaining entries (this request not yet added).
//   3. ZADD             — add the current request keyed by a unique nonce.
//   4. PEXPIRE          — TTL safety so abandoned keys don't leak.
//
// Steps 1–4 run in a single MULTI pipeline so we never miss a beat under
// concurrency.

let _ioredisClient: IoRedisType | null = null;

async function getIoredisClient(): Promise<IoRedisType> {
  if (_ioredisClient) return _ioredisClient;
  if (!env.ALIYUN_REDIS_URL) {
    throw new Error('aliyun-redis-url-missing — set ALIYUN_REDIS_URL on CN deploy');
  }
  // Dynamic import: GLOBAL stack must not pull ioredis at boot.
  const mod = await import('ioredis');
  const Ctor = (mod as unknown as { default: new (url: string, opts?: unknown) => IoRedisType })
    .default;
  _ioredisClient = new Ctor(env.ALIYUN_REDIS_URL, {
    // ACK→Aliyun-Redis is intra-VPC so 1s connect timeout is generous.
    connectTimeout: 1_000,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });
  return _ioredisClient;
}

function buildAliyunRedisLimiter(prefix: string, limit: number, windowMs: number): Limiter {
  const fullKeyPrefix = `kitora:${prefix}`;

  return {
    async limit(key: string) {
      // If ALIYUN_REDIS_URL is unset (e.g. local dev with KITORA_REGION=CN
      // pointed at a stub stack), behave as no-op rather than crash hot
      // paths. The startup-check guard (RFC 0005) is the place we'd panic
      // about a misconfigured CN deploy, not here.
      if (!env.ALIYUN_REDIS_URL) {
        return { success: true, remaining: Infinity, limit, reset: 0 };
      }
      const client = await getIoredisClient();
      const fullKey = `${fullKeyPrefix}:${key}`;
      const now = Date.now();
      const windowStart = now - windowMs;
      // Nonce avoids two requests landing at the exact same `now` from
      // colliding on the sorted-set member uniqueness.
      const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

      const pipeline = client.multi();
      pipeline.zremrangebyscore(fullKey, 0, windowStart);
      pipeline.zcard(fullKey);
      pipeline.zadd(fullKey, now, member);
      pipeline.pexpire(fullKey, windowMs + 5_000); // small grace
      const results = await pipeline.exec();

      // results: [[err, n], [err, count], [err, '1'|'0'], [err, '1'|'0']]
      // ZCARD reflects the count *before* this request's ZADD — so a count
      // < limit means there's room for us; >= limit is the rejection.
      const count = results && Array.isArray(results[1]) ? Number(results[1][1] ?? 0) : 0;
      const success = count < limit;
      const remaining = Math.max(0, limit - count - 1);
      const reset = now + windowMs;
      return { success, remaining, limit, reset };
    },
  };
}

// ─── Upstash branch (existing GLOBAL behaviour) ────────────────────────────

function buildUpstashLimiter(
  prefix: string,
  requests: number,
  window: `${number} ${'s' | 'm' | 'h'}`,
): Limiter {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    return noopLimiter();
  }
  const redis = new UpstashRedis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
  return new Ratelimit({
    redis,
    prefix: `kitora:${prefix}`,
    limiter: Ratelimit.slidingWindow(requests, window),
    analytics: true,
  });
}

// ─── Region-aware factory ──────────────────────────────────────────────────

function buildLimiter(
  prefix: string,
  requests: number,
  window: `${number} ${'s' | 'm' | 'h'}`,
): Limiter {
  if (isCnRegion()) {
    return buildAliyunRedisLimiter(prefix, requests, parseWindowMs(window));
  }
  return buildUpstashLimiter(prefix, requests, window);
}

/** 10 reqs / 10s — for login/signup endpoints */
export const authLimiter = buildLimiter('auth', 10, '10 s');

/** 60 reqs / minute — for general API endpoints */
export const apiLimiter = buildLimiter('api', 60, '1 m');

/** 5 reqs / minute — for expensive operations (password reset, email send) */
export const strictLimiter = buildLimiter('strict', 5, '1 m');
