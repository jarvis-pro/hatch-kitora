// 注意：这里故意*不*是 `'server-only'` ——Playwright e2e 测试
// 在进程内驱动 `runWebhookCronTick` 以断言端到端的 DELIVERED
// 状态写入。传递的 `@/lib/db`（prisma）+ `@/env` 依赖仍然
// 防止意外的客户端捆绑。
//
// cron worker 的库形式。CLI 入口（`scripts/run-webhook-cron.ts`）
// 是一个薄包装，调用 `runWebhookCronTick()` 并将错误转换
// 为非零退出代码。

import { logger } from '@/lib/logger';
import { prisma } from '@/lib/db';

import { deliverWebhook } from './deliver';
import { sendWebhookAutoDisabledEmail } from './email-flows';
import { decryptSecret } from './secret';

const STUCK_MS = 5 * 60 * 1000;
const BATCH = 50;
// RFC 0003 PR-4 — 自动禁用阈值。8 个连续失败 × 重试曲线（约 44 小时）
// 在我们暂停端点前约 2 天的痛苦。可在此处调整而不触及状态机。
const AUTO_DISABLE_THRESHOLD = 8;
// 终端交付保留。超过这个时间，即使用户可能想"重新发送"，
// 我们也不会保留该行——实际经验表明没有人追踪这么久远的 webhook，
// 否则表会快速增长。
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * RFC 0003 PR-2 — 出站 webhook cron 时钟。
 *
 * 每次调用的三个阶段，镜像 `scripts/run-export-jobs.ts`：
 *
 *   1. 恢复卡住——任何 PENDING 的东西，其 `nextAttemptAt` 年龄超过 STUCK_MS
 *      （约 5 分钟）很可能是之前的 worker 在获取中崩溃；
 *      轻推它回来，以便这个时钟可以接它。
 *   2. 声明+交付——拉起最多 BATCH 行，其 `nextAttemptAt < now`
 *      和 `status IN (PENDING, RETRYING)`，通过翻转到
 *      "声明"哨兵（我们重用 PENDING 加上 `nextAttemptAt = null` 墓碑）
 *      来乐观声明每一行，然后 POST 和写回。
 *   3. 清扫孤儿——端点禁用/删除可能会留下 PENDING 行。
 *      那些被翻转为 CANCELED，以便队列保持有界。
 *
 * "声明"技巧：Prisma 中没有 ON CONFLICT 语义我们可以用于
 * 批量声明，所以 worker 调用 `updateMany`，其中包含它刚刚 SELECTed
 * 的行 ID 列表。无论谁赢得第二个 updateMany 拥有该行——
 * 重复项产生 0 行更新并被静默跳过。
 */
export async function runWebhookCronTick(): Promise<void> {
  await recoverStuck();
  await claimAndDeliver();
  await sweepOrphans();
  await sweepTerminalDeliveries();
}

async function recoverStuck() {
  // PENDING 行的 `nextAttemptAt` 比 STUCK_MS 更早
  // 属于崩溃的 worker。用提升的 `nextAttemptAt` 进行 updateMany
  // 将它们向前推移；状态不改变。
  const cutoff = new Date(Date.now() - STUCK_MS);
  const result = await prisma.webhookDelivery.updateMany({
    where: {
      status: 'PENDING',
      nextAttemptAt: { lt: cutoff },
      // 跳过刚入队的行——这些是故意接近现在的。
      // 我们只想救援*陈旧的* PENDINGs。
    },
    data: { nextAttemptAt: new Date() },
  });
  if (result.count > 0) {
    logger.warn({ count: result.count }, 'webhook-cron-stuck-recovered');
  }
}

async function claimAndDeliver() {
  const now = new Date();
  // 第 1 阶段：挑选候选者。
  const candidates = await prisma.webhookDelivery.findMany({
    where: {
      status: { in: ['PENDING', 'RETRYING'] },
      nextAttemptAt: { lte: now },
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: BATCH,
    select: { id: true },
  });
  if (candidates.length === 0) return;

  for (const { id } of candidates) {
    // 第 2 阶段：乐观声明。无论哪个 worker 赢得翻转行
    // 到一个"声明"状态，我们表示为 `status = PENDING, nextAttemptAt
    // = null`。未来的 cron 时钟不会重新拾取一个 null-nextAttemptAt 行。
    const claim = await prisma.webhookDelivery.updateMany({
      where: { id, status: { in: ['PENDING', 'RETRYING'] }, nextAttemptAt: { lte: now } },
      data: { nextAttemptAt: null, status: 'PENDING' },
    });
    if (claim.count === 0) continue; // 别人得到它

    const delivery = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        eventId: true,
        eventType: true,
        payload: true,
        attempt: true,
        endpoint: {
          select: {
            id: true,
            url: true,
            encSecret: true,
            disabledAt: true,
            consecutiveFailures: true,
          },
        },
      },
    });

    // 端点在飞行中被禁用 → CANCELED，没有获取。
    if (delivery.endpoint.disabledAt) {
      await prisma.webhookDelivery.update({
        where: { id },
        data: {
          status: 'CANCELED',
          errorMessage: 'endpoint-disabled',
          completedAt: new Date(),
        },
      });
      continue;
    }

    // 端点在 PR-2 之前（没有 encSecret）。标记为 DEAD_LETTER
    // 并带有清晰的错误，以便用户知道旋转密钥 + 重试。
    // 对于迁移后创建的端点应该永远不会发生。
    if (!delivery.endpoint.encSecret) {
      await prisma.webhookDelivery.update({
        where: { id },
        data: {
          status: 'DEAD_LETTER',
          errorMessage: 'endpoint-missing-encrypted-secret-rotate-and-retry',
          completedAt: new Date(),
        },
      });
      continue;
    }

    let plainSecret: string;
    try {
      plainSecret = decryptSecret(delivery.endpoint.id, Buffer.from(delivery.endpoint.encSecret));
    } catch (err) {
      // 解密失败意味着 AUTH_SECRET 旋转但没有重新加密。
      // 与上面缺少 encSecret 相同的恢复路径。
      logger.error({ err, endpointId: delivery.endpoint.id }, 'webhook-decrypt-failed');
      await prisma.webhookDelivery.update({
        where: { id },
        data: {
          status: 'DEAD_LETTER',
          errorMessage: 'secret-decrypt-failed',
          completedAt: new Date(),
        },
      });
      continue;
    }

    const result = await deliverWebhook({
      url: delivery.endpoint.url,
      secret: plainSecret,
      eventId: delivery.eventId,
      eventType: delivery.eventType,
      payload: delivery.payload as object,
      attempt: delivery.attempt + 1,
    });

    // 第 3 阶段：写回结果。
    await applyOutcome(delivery.id, delivery.endpoint.id, delivery.attempt + 1, result);
  }
}

type ApplyResult = Awaited<ReturnType<typeof deliverWebhook>>;

async function applyOutcome(
  deliveryId: string,
  endpointId: string,
  newAttempt: number,
  result: ApplyResult,
) {
  if (result.kind === 'delivered') {
    await prisma.$transaction([
      prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'DELIVERED',
          attempt: newAttempt,
          responseStatus: result.responseStatus,
          responseBody: result.responseBody,
          completedAt: new Date(),
        },
      }),
      prisma.webhookEndpoint.update({
        where: { id: endpointId },
        data: { consecutiveFailures: 0 },
      }),
    ]);
    return;
  }
  if (result.kind === 'dead-letter') {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'DEAD_LETTER',
        attempt: newAttempt,
        responseStatus: result.responseStatus,
        responseBody: result.responseBody,
        errorMessage: result.errorMessage?.slice(0, 500) ?? null,
        completedAt: new Date(),
      },
    });
    await bumpFailuresAndMaybeDisable(endpointId);
    return;
  }
  // 重试
  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: 'RETRYING',
      attempt: newAttempt,
      responseStatus: result.responseStatus,
      responseBody: result.responseBody,
      errorMessage: result.errorMessage?.slice(0, 500) ?? null,
      nextAttemptAt: new Date(Date.now() + result.delayMs),
    },
  });
  await bumpFailuresAndMaybeDisable(endpointId);
}

/**
 * 增加 `consecutiveFailures`，并且——如果我们刚好超过自动禁用
 * 阈值——翻转 `disabledAt`，写一个 actor=null 审计行，并向
 * 组织的 OWNER + ADMIN 发送电子邮件。幂等性：disabledAt 防护
 * 意味着相同端点的第二次交叉是无操作的。
 *
 * 从 `applyOutcome` 分离出来（并*不*在 $transaction 中），
 * 因为我们需要 `consecutiveFailures` 的更新后值来决定是否禁用。
 * Prisma 的交互式事务可以表达这一点，但这里最坏的情况是
 * 在 worker 竞争中双倍发送电子邮件——不会破坏状态——所以我们保持简单。
 */
async function bumpFailuresAndMaybeDisable(endpointId: string): Promise<void> {
  const updated = await prisma.webhookEndpoint.update({
    where: { id: endpointId },
    data: { consecutiveFailures: { increment: 1 } },
    select: {
      id: true,
      orgId: true,
      url: true,
      consecutiveFailures: true,
      disabledAt: true,
    },
  });
  if (updated.disabledAt) return; // 已经暂停——没有什么要做
  if (updated.consecutiveFailures < AUTO_DISABLE_THRESHOLD) return;

  await autoDisableEndpoint(updated);
}

interface DisableTarget {
  id: string;
  orgId: string;
  url: string;
  consecutiveFailures: number;
}

async function autoDisableEndpoint(endpoint: DisableTarget): Promise<void> {
  const now = new Date();
  // where 子句防止与手动编辑的竞争——我们仅在 disabledAt 仍为 null 时翻转。
  // 如果有人赢了（例如管理员在同一个 tick 中手动禁用或重新启用），
  // updateMany 返回计数 0。
  const flip = await prisma.webhookEndpoint.updateMany({
    where: { id: endpoint.id, disabledAt: null },
    data: { disabledAt: now },
  });
  if (flip.count === 0) {
    return; // 别人已经暂停 / 重新启用——他们拥有审计行
  }

  // 审计行。我们故意*不*在这里调用 `recordAudit()`，因为这会
  // 通过 `bridgeAuditToWebhook` 往返并尝试为 `webhook.endpoint_auto_disabled`
  // 排队交付到*我们刚刚禁用的同一端点*——这正是 RFC 第 8 节
  // 所呼吁的死亡循环。直接插入绕过桥接。
  await prisma.auditLog.create({
    data: {
      actorId: null, // 系统动作
      orgId: endpoint.orgId,
      action: 'webhook.endpoint_auto_disabled',
      target: endpoint.id,
      metadata: {
        url: endpoint.url,
        consecutiveFailures: endpoint.consecutiveFailures,
      },
    },
  });

  // 通知 OWNER + ADMIN。每个收件人的 try/catch 已经
  // 位于 `sendWebhookAutoDisabledEmail` 中，所以一个损坏的收件箱
  // 不能毒害其余的扇出。
  const [org, recipients] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: endpoint.orgId },
      select: { slug: true },
    }),
    prisma.membership.findMany({
      where: { orgId: endpoint.orgId, role: { in: ['OWNER', 'ADMIN'] } },
      select: { user: { select: { email: true, name: true } } },
    }),
  ]);

  if (!org) return; // 孤立的端点——没有人要通知

  await Promise.all(
    recipients
      .map((m) => m.user)
      .filter((u): u is { email: string; name: string | null } => !!u?.email)
      .map((u) =>
        sendWebhookAutoDisabledEmail({
          to: u.email,
          name: u.name,
          endpointUrl: endpoint.url,
          endpointId: endpoint.id,
          orgSlug: org.slug,
          consecutiveFailures: endpoint.consecutiveFailures,
        }),
      ),
  );

  logger.warn(
    {
      endpointId: endpoint.id,
      orgId: endpoint.orgId,
      consecutiveFailures: endpoint.consecutiveFailures,
    },
    'webhook-endpoint-auto-disabled',
  );
}

async function sweepOrphans() {
  // 端点在队列中间翻转为禁用：他们的 PENDING/RETRYING
  // 行仍然漂浮。大规模 CANCEL 它们，以便队列不会永远增长。
  const result = await prisma.webhookDelivery.updateMany({
    where: {
      status: { in: ['PENDING', 'RETRYING'] },
      endpoint: { disabledAt: { not: null } },
    },
    data: { status: 'CANCELED', completedAt: new Date(), errorMessage: 'endpoint-disabled' },
  });
  if (result.count > 0) {
    logger.info({ count: result.count }, 'webhook-cron-orphans-canceled');
  }
}

/**
 * RFC 0003 PR-4 — 终端状态保留扫描。
 *
 * DELIVERED / DEAD_LETTER / CANCELED 行早于 TERMINAL_RETENTION_MS
 * 的被删除。我们不进行软删除，因为产品中没有任何东西历史上读取
 * 已取消的行——仪表板顶部 50 视图仅显示最近的交付。
 *
 * 在每个 cron tick 上运行，而不是作为单独的作业，因为簿记很便宜
 * （单一索引的 deleteMany）并且在这里捆绑它将操作占用量保持为
 * 单一 cron 条目。
 */
async function sweepTerminalDeliveries() {
  const cutoff = new Date(Date.now() - TERMINAL_RETENTION_MS);
  const result = await prisma.webhookDelivery.deleteMany({
    where: {
      status: { in: ['DELIVERED', 'DEAD_LETTER', 'CANCELED'] },
      // `completedAt` 在行到达终端状态时设置；在罕见情况下
      // 它不是（旧数据），通过 OR 回退到 createdAt。
      OR: [{ completedAt: { lt: cutoff } }, { completedAt: null, createdAt: { lt: cutoff } }],
    },
  });
  if (result.count > 0) {
    logger.info({ count: result.count }, 'webhook-cron-terminal-swept');
  }
}
