/**
 * RFC 0008 PR-4 / 复盘 P0-3 — Vercel Cron 入口路由单测。
 *
 * 锁住四条决策路径：
 *   1. CRON_SECRET 未配 → 503 短路（dev / e2e 默认；本地访问不会误触发整套 sweep）
 *   2. Authorization header 缺失 / 错误 → 401（不区分错误码，避免给探测者增量信息）
 *   3. VERCEL_PLAN === 'hobby' → 收紧 batchSize=1, budgetMs=8_000（function 10s 留 2s 兜底）
 *   4. VERCEL_PLAN 缺失 / 非 hobby → 默认 budget（Pro 60s / 自托管不限）
 *   5. fireSchedules / runWorkerTick 抛错 → 500 + workerId 透传给运维排障
 *
 * 路径 3、4 是复盘 P0-3 的核心修复 —— 必须有单测锁住，避免谁手贱删掉 hobby 探测让
 * Hobby 部署再次卡死 RUNNING 行。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/jobs/bootstrap', () => ({}));
vi.mock('@/services/jobs/runner', () => ({
  runWorkerTick: vi.fn(),
}));
vi.mock('@/services/jobs/schedules', () => ({
  fireSchedules: vi.fn(),
}));
vi.mock('@/env', () => ({
  env: {} as { CRON_SECRET?: string },
}));
// 直接 stub logger，避免 transitively 拉起 pino —— pino 会在加载阶段
// 读 env.LOG_LEVEL 初始化，被 mock 后的 env 给不出该字段就抛
// "default level:undefined must be included in custom levels"。
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { env } from '@/env';
import { runWorkerTick } from '@/services/jobs/runner';
import { fireSchedules } from '@/services/jobs/schedules';

import { GET } from './route';

const mockedRunWorkerTick = runWorkerTick as ReturnType<typeof vi.fn>;
const mockedFireSchedules = fireSchedules as ReturnType<typeof vi.fn>;
const mockedEnv = env as { CRON_SECRET?: string };

const CRON_SECRET = 'test-cron-secret-min-32-chars-padding-x';

function makeRequest(opts: { authorization?: string } = {}): Request {
  const headers = new Headers();
  if (opts.authorization) headers.set('authorization', opts.authorization);
  return new Request('https://app.kitora.com/api/jobs/tick', {
    method: 'GET',
    headers,
  });
}

beforeEach(() => {
  mockedRunWorkerTick.mockReset();
  mockedFireSchedules.mockReset();
  mockedRunWorkerTick.mockResolvedValue({ claimed: 0, processed: 0, deadLettered: 0 });
  mockedFireSchedules.mockResolvedValue({ matched: [], enqueued: [], deduplicated: [] });
  mockedEnv.CRON_SECRET = CRON_SECRET;
  delete process.env.VERCEL_PLAN;
});

afterEach(() => {
  delete process.env.VERCEL_PLAN;
});

describe('CRON_SECRET 未配', () => {
  it('返回 503 cron-not-configured（dev / e2e 默认安全短路）', async () => {
    mockedEnv.CRON_SECRET = undefined;
    const res = await GET(makeRequest({ authorization: `Bearer ${CRON_SECRET}` }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('cron-not-configured');
    // 503 路径不应触发任何 jobs 运行
    expect(mockedFireSchedules).not.toHaveBeenCalled();
    expect(mockedRunWorkerTick).not.toHaveBeenCalled();
  });

  it('Cache-Control: no-store（防代理意外缓存配置错误响应）', async () => {
    mockedEnv.CRON_SECRET = undefined;
    const res = await GET(makeRequest());
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('鉴权', () => {
  it('缺失 Authorization → 401', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockedRunWorkerTick).not.toHaveBeenCalled();
  });

  it('错误 secret → 401（与缺失同响应，不暴露增量信息）', async () => {
    const res = await GET(makeRequest({ authorization: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unauthorized');
    expect(mockedRunWorkerTick).not.toHaveBeenCalled();
  });

  it('Bearer 前缀错（Basic xxx）→ 401', async () => {
    const res = await GET(makeRequest({ authorization: `Basic ${CRON_SECRET}` }));
    expect(res.status).toBe(401);
  });

  it('正确 secret → 进入 fireSchedules + runWorkerTick', async () => {
    const res = await GET(makeRequest({ authorization: `Bearer ${CRON_SECRET}` }));
    expect(res.status).toBe(200);
    expect(mockedFireSchedules).toHaveBeenCalledOnce();
    expect(mockedRunWorkerTick).toHaveBeenCalledOnce();
  });
});

describe('VERCEL_PLAN 自适应 budget（复盘 P0-3）', () => {
  it('VERCEL_PLAN=hobby → batchSize=1, budgetMs=8_000', async () => {
    process.env.VERCEL_PLAN = 'hobby';
    await GET(makeRequest({ authorization: `Bearer ${CRON_SECRET}` }));
    expect(mockedRunWorkerTick).toHaveBeenCalledWith(expect.any(String), {
      batchSize: 1,
      budgetMs: 8_000,
    });
  });

  it('VERCEL_PLAN=pro → 默认 budget（不传第二参数）', async () => {
    process.env.VERCEL_PLAN = 'pro';
    await GET(makeRequest({ authorization: `Bearer ${CRON_SECRET}` }));
    expect(mockedRunWorkerTick).toHaveBeenCalledWith(expect.any(String), undefined);
  });

  it('VERCEL_PLAN=enterprise → 默认 budget', async () => {
    process.env.VERCEL_PLAN = 'enterprise';
    await GET(makeRequest({ authorization: `Bearer ${CRON_SECRET}` }));
    expect(mockedRunWorkerTick).toHaveBeenCalledWith(expect.any(String), undefined);
  });

  it('未托管 Vercel（VERCEL_PLAN 缺失）→ 默认 budget', async () => {
    delete process.env.VERCEL_PLAN;
    await GET(makeRequest({ authorization: `Bearer ${CRON_SECRET}` }));
    expect(mockedRunWorkerTick).toHaveBeenCalledWith(expect.any(String), undefined);
  });
});

describe('成功路径', () => {
  it('200 + workerId 形如 vercel-cron-<ts> + sched / tick 透传', async () => {
    mockedFireSchedules.mockResolvedValueOnce({
      matched: ['s1'],
      enqueued: ['s1'],
      deduplicated: [],
    });
    mockedRunWorkerTick.mockResolvedValueOnce({ claimed: 3, processed: 2, deadLettered: 0 });

    const res = await GET(makeRequest({ authorization: `Bearer ${CRON_SECRET}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      workerId: string;
      sched: { matched: string[] };
      tick: { claimed: number };
    };
    expect(body.ok).toBe(true);
    expect(body.workerId).toMatch(/^vercel-cron-\d+$/);
    expect(body.sched.matched).toEqual(['s1']);
    expect(body.tick.claimed).toBe(3);
  });

  it('Cache-Control: no-store（成功响应也不应被代理缓存）', async () => {
    const res = await GET(makeRequest({ authorization: `Bearer ${CRON_SECRET}` }));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('错误路径', () => {
  it('fireSchedules 抛错 → 500 tick-failed + workerId 透传', async () => {
    mockedFireSchedules.mockRejectedValueOnce(new Error('schedules-blew-up'));
    const res = await GET(makeRequest({ authorization: `Bearer ${CRON_SECRET}` }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; workerId: string };
    expect(body.error).toBe('tick-failed');
    expect(body.workerId).toMatch(/^vercel-cron-\d+$/);
    // runWorkerTick 在 fireSchedules 之后，不应被调用
    expect(mockedRunWorkerTick).not.toHaveBeenCalled();
  });

  it('runWorkerTick 抛错（claim SQL 失败等）→ 500 tick-failed', async () => {
    mockedRunWorkerTick.mockRejectedValueOnce(new Error('claim-sql-failed'));
    const res = await GET(makeRequest({ authorization: `Bearer ${CRON_SECRET}` }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('tick-failed');
  });
});
