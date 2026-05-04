/**
 * RFC 0008 §4.2 / §7 — `enqueueJob` / `cancelJob`。
 *
 * 调用方门面：
 *
 * ```ts
 * await enqueueJob('email.send', { to, subject, ... });
 * await enqueueJob('subscription.dunning', { ... }, {
 *   runId: `subscription:${id}:dunning`, // 幂等键
 *   delay: 30_000,                       // 30 秒后再可被 claim
 * });
 * ```
 *
 * 关键不变量（与 RFC 0008 §7 风险表对应）：
 *
 *   - **payload 64KB 上限** — 防止 jsonb 列被 ad-hoc 长 payload 撑爆；超过请把 payload
 *     落 storage、表里只放 ref（与 RFC 0002 数据导出 pattern 一致）。
 *   - **runId 重复 → swallow** — Prisma P2002 走「等价 enqueue 已存在」语义，
 *     返回 `{ deduplicated: true }` + 现有行 id；不抛错。这是「调度想拍 dunning,
 *     上一次已经在路上」这种常见场景的正确语义。
 *   - **未注册 type → 抛错** — `enqueueJob('typo.send', ...)` 在 dev/CI 期阻断，
 *     不让错误 type 落进 DB（让 worker 在跑时再发现就太晚）。
 *
 * 类型安全：v1 通用签名是 `(type: string, payload: unknown)`，靠运行时 zod 把关；
 * PR-3 通过 module augmentation 给具体 type 加 typed overload。
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';

import { getJob } from './registry';

const PAYLOAD_BYTE_LIMIT = 64 * 1024;

/**
 * 入队选项。
 * @property runId - 幂等键；同 (type, runId) 在表里唯一。重复 enqueue 返回 deduplicated=true。
 * @property priority - v1 全用默认 0；预留给 RFC 0010+ 高优场景。
 * @property delayMs - 最早可被 claim 的时刻偏移（毫秒）。默认 0 = 立即。
 * @property queue - v1 worker 只 claim `'default'`，但调用方可以塞别的 queue 名字给将来分流准备。
 */
export interface EnqueueOptions {
  runId?: string;
  priority?: number;
  delayMs?: number;
  queue?: string;
}

/**
 * 入队结果。
 * @property id - 任务 ID。
 * @property deduplicated - true = 撞了 (type, runId) unique，复用现有 PENDING/RUNNING 行；false = 新建。
 */
export interface EnqueueResult {
  id: string;
  deduplicated: boolean;
}

/**
 * 入队后台任务。
 * @param type - 任务类型。
 * @param payload - 任务负载。
 * @param opts - 入队选项。
 * @returns 入队结果。
 * @throws 如果任务类型未注册或 payload 验证失败。
 */
export async function enqueueJob(
  type: string,
  payload: unknown,
  opts: EnqueueOptions = {},
): Promise<EnqueueResult> {
  const def = getJob(type);
  if (!def) {
    throw new Error(
      `enqueueJob: unknown job type "${type}" — was defineJob() imported before enqueue?`,
    );
  }

  // zod 校验是 v1 第一道把关；PR-3 加 TS overload 后这里仍跑做二道防线。
  const parsed = def.payloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`enqueueJob: payload validation failed for "${type}": ${parsed.error.message}`);
  }

  const serialized = JSON.stringify(parsed.data);
  const byteLen = Buffer.byteLength(serialized, 'utf8');
  if (byteLen > PAYLOAD_BYTE_LIMIT) {
    throw new Error(
      `enqueueJob: payload exceeds 64KB limit for "${type}" (${byteLen} bytes) — store the blob in object storage and pass a ref instead`,
    );
  }

  const nextAttemptAt =
    opts.delayMs && opts.delayMs > 0 ? new Date(Date.now() + opts.delayMs) : new Date();
  const queue = opts.queue ?? def.queue;
  const runId = opts.runId ?? null;

  try {
    const row = await prisma.backgroundJob.create({
      data: {
        type,
        payload: parsed.data as Prisma.InputJsonValue,
        runId,
        priority: opts.priority ?? 0,
        queue,
        maxAttempts: def.maxAttempts,
        nextAttemptAt,
      },
      select: { id: true },
    });
    return { id: row.id, deduplicated: false };
  } catch (err) {
    if (isUniqueConstraintViolation(err) && runId !== null) {
      // 撞 (type, runId) unique —— swallow 并返回现有行。
      const existing = await prisma.backgroundJob.findUnique({
        where: { type_runId: { type, runId } },
        select: { id: true },
      });
      if (existing) {
        return { id: existing.id, deduplicated: true };
      }
      // 极端 race：unique 撞了但又 fetch 不到（被 prune 走了？）—— 仍上抛。
    }
    throw err;
  }
}

/**
 * 将一行 PENDING 翻为 CANCELED。返回 true = 翻成功；false = 行不存在或已不在 PENDING
 * （可能已经被 worker claim，或者 admin / 用户已 cancel 过）。
 *
 * RUNNING 行不能直接 cancel —— caller 得等当次 run 结束（成功/失败/超时崩溃恢复）。
 * 这是 v1 的明确权衡：要让 RUNNING 也 cancel 必须做 AbortController 全链路传递，
 * v1 不投资。
 * @param id - 任务 ID。
 * @returns 是否成功取消。
 */
export async function cancelJob(id: string): Promise<boolean> {
  const result = await prisma.backgroundJob.updateMany({
    where: { id, status: 'PENDING' },
    data: {
      status: 'CANCELED',
      completedAt: new Date(),
    },
  });
  return result.count === 1;
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
