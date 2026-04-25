import 'server-only';

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

import { env } from '@/env';

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

function buildLimiter(
  prefix: string,
  requests: number,
  window: `${number} ${'s' | 'm' | 'h'}`,
): Limiter {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    return noopLimiter();
  }
  const redis = new Redis({
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

/** 10 reqs / 10s — for login/signup endpoints */
export const authLimiter = buildLimiter('auth', 10, '10 s');

/** 60 reqs / minute — for general API endpoints */
export const apiLimiter = buildLimiter('api', 60, '1 m');

/** 5 reqs / minute — for expensive operations (password reset, email send) */
export const strictLimiter = buildLimiter('strict', 5, '1 m');
