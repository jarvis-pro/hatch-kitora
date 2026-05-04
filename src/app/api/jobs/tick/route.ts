/**
 * RFC 0008 §4.5 / §5.1 / PR-4 — Vercel Cron 入口（HTTP 形式的 run-jobs.ts）。
 *
 * Vercel Cron 一分钟一次 GET 此路由，与 `scripts/run-jobs.ts` CLI 跑一模一样的
 * `fireSchedules → runWorkerTick` 序列 —— 两个入口共用 `@/services/jobs/*` 一套实现，
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
 * `maxDuration = 60`：Vercel Pro 60s function timeout；Hobby 自动收紧到 10s。
 * 路由层根据 `VERCEL_PLAN` env 自适应 `runWorkerTick` 预算：
 *   - Pro / Enterprise → batchSize 5、budgetMs 50_000（默认）
 *   - Hobby            → batchSize 1、budgetMs 8_000（function 10s 留 2s 兜底）
 *   - 未托管 Vercel    → 默认（自托管 / Fly Machines / ACK 走 CLI 入口，无 HTTP 限制）
 *
 * Vercel 在每个 invocation 自动注入 `VERCEL_PLAN`（取值 'hobby' | 'pro' | 'enterprise'）。
 * 详情见 https://vercel.com/docs/projects/environment-variables/system-environment-variables。
 */

import { NextResponse } from 'next/server';

import { env } from '@/env';
import '@/services/jobs/bootstrap'; // 副作用：把所有 job / schedule 注册进 registry
import { runWorkerTick } from '@/services/jobs/runner';
import { fireSchedules } from '@/services/jobs/schedules';
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
  // Hobby 计划 function timeout = 10s，给自身留 2s 兜底；同时 batchSize 收到 1，
  // 避免一次 tick 跑多个 job 撞 timeout 让所有 RUNNING 行集体卡死。
  const isHobby = process.env.VERCEL_PLAN === 'hobby';
  const tickOpts = isHobby ? { batchSize: 1, budgetMs: 8_000 } : undefined;
  try {
    const sched = await fireSchedules();
    const tick = await runWorkerTick(workerId, tickOpts);
    logger.info({ workerId, sched, tick, plan: process.env.VERCEL_PLAN }, 'jobs-tick-route-done');
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
