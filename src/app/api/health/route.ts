import { NextResponse } from 'next/server';

import { env } from '@/env';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CheckResult {
  ok: boolean;
  /** 往返时间（以毫秒为单位）；如果检查被跳过或从未启动，则为 null。*/
  latencyMs: number | null;
  /** 可选的人类注释（例如"跳过——未配置"）。*/
  note?: string;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    await fn();
    return { ok: true, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

async function dbCheck(): Promise<CheckResult> {
  return timed(() => prisma.$queryRaw`SELECT 1`);
}

async function redisCheck(): Promise<CheckResult> {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    return { ok: true, latencyMs: null, note: 'skipped — not configured' };
  }
  const start = Date.now();
  try {
    const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/ping`, {
      headers: { authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
      cache: 'no-store',
      // 2 秒尾部上限；负载均衡器通常超时长得多。
      signal: AbortSignal.timeout(2000),
    });
    return { ok: res.ok, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

export async function GET() {
  const [db, redis] = await Promise.all([dbCheck(), redisCheck()]);
  const ok = db.ok && redis.ok;

  return NextResponse.json(
    {
      status: ok ? 'ok' : 'degraded',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      checks: { db, redis },
    },
    {
      status: ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    },
  );
}
