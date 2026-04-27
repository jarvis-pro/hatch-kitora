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

// ─── Window parsing（Upstash + Aliyun 分支之间共享）─────────────

const WINDOW_UNIT_MS: Record<'s' | 'm' | 'h', number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

function parseWindowMs(window: `${number} ${'s' | 'm' | 'h'}`): number {
  const [n, unit] = window.split(' ') as [string, 's' | 'm' | 'h'];
  return Number(n) * WINDOW_UNIT_MS[unit];
}

// ─── Aliyun Redis 分支（RFC 0006 PR-4）───────────────────────────────────
//
// CN 区域使用 ioredis（TCP）针对 Aliyun Redis 实例 — Upstash
// REST 在 GFW 的错误一侧用于热路径速率限制检查
//（≥200ms RTT，远超 5ms 预算）。Sliding window 是手工制作的
// 因为 @upstash/ratelimit 的 limiter 抽象期望一个 Upstash
// Redis 接口该接口包装 REST 语义；桥接它比只在
// 3 个 Redis 操作中做算法要多代码。
//
// 算法（排序集窗口）：
//   1. ZREMRANGEBYSCORE — 删除早于 `now - windowMs` 的条目。
//   2. ZCARD            — 计数剩余条目（此请求尚未添加）。
//   3. ZADD             — 添加以唯一 nonce 为键的当前请求。
//   4. PEXPIRE          — TTL 安全所以被遗弃的密钥不会泄漏。
//
// 步骤 1–4 在单个 MULTI 管道中运行，所以在并发下我们永远
// 不错过节拍。

let _ioredisClient: IoRedisType | null = null;

async function getIoredisClient(): Promise<IoRedisType> {
  if (_ioredisClient) return _ioredisClient;
  if (!env.ALIYUN_REDIS_URL) {
    throw new Error('aliyun-redis-url-missing — 在 CN 部署上设置 ALIYUN_REDIS_URL');
  }
  // 动态导入：GLOBAL 堆栈不能在启动时拉取 ioredis。
  const mod = await import('ioredis');
  const Ctor = (mod as unknown as { default: new (url: string, opts?: unknown) => IoRedisType })
    .default;
  _ioredisClient = new Ctor(env.ALIYUN_REDIS_URL, {
    // ACK→Aliyun-Redis 是 intra-VPC 所以 1s 连接超时很慷慨。
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
      // 如果 ALIYUN_REDIS_URL 未设置（例如本地开发 KITORA_REGION=CN
      // 指向 stub stack），表现为无操作而不是在热路径崩溃。
      // 启动检查保护（RFC 0005）是我们会对配置错误的 CN 部署感到恐慌的地方，
      // 不是这里。
      if (!env.ALIYUN_REDIS_URL) {
        return { success: true, remaining: Infinity, limit, reset: 0 };
      }
      const client = await getIoredisClient();
      const fullKey = `${fullKeyPrefix}:${key}`;
      const now = Date.now();
      const windowStart = now - windowMs;
      // Nonce 避免两个请求在精确相同的 `now` 降落的情况
      // 在排序集成员唯一性上碰撞。
      const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

      const pipeline = client.multi();
      pipeline.zremrangebyscore(fullKey, 0, windowStart);
      pipeline.zcard(fullKey);
      pipeline.zadd(fullKey, now, member);
      pipeline.pexpire(fullKey, windowMs + 5_000); // small grace
      const results = await pipeline.exec();

      // results: [[err, n], [err, count], [err, '1'|'0'], [err, '1'|'0']]
      // ZCARD 反映此请求 ZADD 之前的计数 — 所以计数
      // < limit 意味着有我们的空间；>= limit 是拒绝。
      const count = results && Array.isArray(results[1]) ? Number(results[1][1] ?? 0) : 0;
      const success = count < limit;
      const remaining = Math.max(0, limit - count - 1);
      const reset = now + windowMs;
      return { success, remaining, limit, reset };
    },
  };
}

// ─── Upstash 分支（现有 GLOBAL 行为）────────────────────────────────

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

// ─── 区域感知的工厂 ──────────────────────────────────────────────────────

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

/** 10 请求 / 10s — 用于登录/注册端点 */
export const authLimiter = buildLimiter('auth', 10, '10 s');

/** 60 请求 / 分钟 — 用于常规 API 端点 */
export const apiLimiter = buildLimiter('api', 60, '1 m');

/** 5 请求 / 分钟 — 用于昂贵的操作（密码重置、邮件发送） */
export const strictLimiter = buildLimiter('strict', 5, '1 m');
