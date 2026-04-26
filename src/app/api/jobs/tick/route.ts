/**
 * RFC 0008 §4.5 / §5.1 / PR-4 — Vercel Cron 入口（HTTP 形式的 run-jobs.ts）。
 *
 * Vercel Cron 一分钟一次 GET 此路由，与 `scripts/run-jobs.ts` CLI 跑一模一样的
 * `fireSchedules → runWorkerTick` 序列 —— 两个入口共用 `@/lib/jobs/*` 一套实现，
 * 维护成本只有一份。
 *
 * 鉴权：`Authorization: Bearer ${CRON_SECRET}` 严格匹配。Vercel Cron 自动注入此
 * header（其中 `CRON_SECRET` 必须在 Vercel 项目 env 里配）；外部 / 攻击者无 header
 * 一律 401，且不区分 401/403 / 不暴露路径存在性，沿用 RFC 0003 webhook 同款模式。
 *
 * `CRON_SECRET` 未配（dev / e2e 默认）时返回 503「cron-not-configured」短路 ——
 * 让本地 dev `pnpm dev` 启动后访问该路径不会误触发整套 sweep（生产 OOM 隐患的
 * 第一道防线）。CLI `pnpm tsx scripts/run-jobs.ts` 不走 HTTP 完全无影响。
 *
 * `maxDuration = 60`：Vercel Pro 60s function timeout；Hobby 自动收紧到 10s
 * （需要把 runWorkerTick 的 budgetMs 调到 8s + batchSize 1，本路由暂不做特殊处理，
 * 部署 Hobby 的用户用 `scripts/run-jobs.ts` 走 Fly Machines Cron 替代）。
 */

import { NextResponse } from 'next/server';

import { env } from '@/env';
import '@/lib/jobs/bootstrap'; // 副作用：把所有 job / schedule 注册进 registry
import { runWorkerTick } from '@/lib/jobs/runner';
import { fireSchedules } from '@/lib/jobs/schedules';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  const expected = env.CRON_SECRET;
  if (!expected) {
    logger.warn('jobs-tick-route-no-secret-configured');
    return NextResponse.json(
      { error: 'cron-not-configured' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${expected}`) {
    // 不区分缺失 vs 错误，避免给探测者增量信息。
    return NextResponse.json(
      { error: 'unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const workerId = `vercel-cron-${Date.now()}`;
  try {
    const sched = await fireSchedules();
    const tick = await runWorkerTick(workerId);
    logger.info({ workerId, sched, tick }, 'jobs-tick-route-done');
    return NextResponse.json(
      { ok: true, workerId, sched, tick },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    // tick 内部已经处理了单个 job 的 error（重试 / DLQ）；只有 fireSchedules
    // / claim SQL 这种 framework-level 错误才会冒到这层。
    logger.error({ err, workerId }, 'jobs-tick-route-fatal');
    return NextResponse.json(
      { error: 'tick-failed', workerId },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
