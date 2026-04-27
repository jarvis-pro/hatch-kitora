'use server';

import { OrgRole } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { WEBHOOK_EVENTS_SET } from '@/lib/webhooks/events';
import { generateWebhookSecret } from '@/lib/webhooks/secret';
import { validateWebhookUrl } from '@/lib/webhooks/url-guard';

/**
 * RFC 0003 PR-1 — webhook endpoint server action（CRUD + rotate-secret）。
 *
 * 授权模型：每个操作通过 `orgSlug` 解析 org，然后
 * 验证调用者在其上具有 OWNER 或 ADMIN 成员资格。我们不
 * 信任 active-org cookie — action 显式获取 slug
 * 以便同一 UI 可以跨 org 管理端点而无需上下文切换
 * 体操。
 *
 * 密钥生命周期：明文仅在 `create` 和
 * `rotateSecret` 上返回。DB 存储 `sha256(plain)` + 一个短 `secretPrefix`
 * 用于 UI 消歧。丢失的密钥无法恢复 — 用户必须
 * 轮换。
 */

const orgScopeSchema = z.object({
  orgSlug: z.string().min(1).max(80),
});

const createSchema = orgScopeSchema.extend({
  url: z.string().url().max(2048),
  description: z.string().max(200).optional(),
  enabledEvents: z.array(z.string().min(1).max(64)).max(WEBHOOK_EVENTS_SET.size).default([]),
});

const updateSchema = orgScopeSchema.extend({
  id: z.string().min(1).max(64),
  url: z.string().url().max(2048).optional(),
  description: z.string().max(200).nullable().optional(),
  enabledEvents: z.array(z.string().min(1).max(64)).max(WEBHOOK_EVENTS_SET.size).optional(),
  // `null` 重新激活之前禁用的端点。
  disabledAt: z.union([z.date(), z.null()]).optional(),
});

const idScopeSchema = orgScopeSchema.extend({
  id: z.string().min(1).max(64),
});

const resendSchema = orgScopeSchema.extend({
  endpointId: z.string().min(1).max(64),
  deliveryId: z.string().min(1).max(64),
});

/**
 * 验证调用者属于具有 ADMIN 或 OWNER 角色的命名 org。
 * 成功时返回已解析的 orgId，auth 失败时返回 null。
 */
async function requireWebhookManager(userId: string, orgSlug: string): Promise<string | null> {
  const membership = await prisma.membership.findFirst({
    where: {
      userId,
      organization: { slug: orgSlug },
      role: { in: [OrgRole.OWNER, OrgRole.ADMIN] },
    },
    select: { orgId: true },
  });
  return membership?.orgId ?? null;
}

function rejectUnknownEvents(events: readonly string[]): { ok: true } | { ok: false; bad: string } {
  for (const e of events) {
    if (!WEBHOOK_EVENTS_SET.has(e)) {
      return { ok: false, bad: e };
    }
  }
  return { ok: true };
}

// ─── Create ─────────────────────────────────────────────────────────────────

export async function createWebhookEndpointAction(input: z.infer<typeof createSchema>) {
  const me = await requireUser();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'invalid-input' as const };

  const orgId = await requireWebhookManager(me.id, parsed.data.orgSlug);
  if (!orgId) return { ok: false as const, error: 'forbidden' as const };

  const verdict = validateWebhookUrl(parsed.data.url);
  if (!verdict.ok) {
    return { ok: false as const, error: verdict.reason };
  }
  const eventCheck = rejectUnknownEvents(parsed.data.enabledEvents);
  if (!eventCheck.ok) {
    return { ok: false as const, error: 'unknown-event' as const, bad: eventCheck.bad };
  }

  const secret = generateWebhookSecret();
  // 两步写入因为 encSecret 是从行 id 派生的 HKDF。
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      orgId,
      url: verdict.url.toString(),
      description: parsed.data.description ?? null,
      enabledEvents: parsed.data.enabledEvents,
      secretHash: secret.hash,
      secretPrefix: secret.prefix,
    },
    select: { id: true, url: true, secretPrefix: true },
  });
  await prisma.webhookEndpoint.update({
    where: { id: endpoint.id },
    data: { encSecret: secret.encryptForEndpoint(endpoint.id) },
  });

  logger.info({ actor: me.id, orgId, endpointId: endpoint.id }, 'webhook-endpoint-created');
  await recordAudit({
    actorId: me.id,
    orgId,
    action: 'webhook.endpoint_created',
    target: endpoint.id,
    metadata: { url: endpoint.url },
  });
  revalidatePath('/settings/organization/webhooks');

  // 明文密钥显示一次 — 调用者必须在 UI 中显示它。
  return {
    ok: true as const,
    endpoint: { id: endpoint.id, url: endpoint.url, secretPrefix: endpoint.secretPrefix },
    secret: secret.plain,
  };
}

// ─── Update ─────────────────────────────────────────────────────────────────

export async function updateWebhookEndpointAction(input: z.infer<typeof updateSchema>) {
  const me = await requireUser();
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'invalid-input' as const };

  const orgId = await requireWebhookManager(me.id, parsed.data.orgSlug);
  if (!orgId) return { ok: false as const, error: 'forbidden' as const };

  // 防御性的：在触及之前确认端点实际上属于此 org。
  // 防止"我是 org A 的 OWNER，但我会 PATCH 属于 org B 的端点 X"
  // 通过猜测 id。
  const existing = await prisma.webhookEndpoint.findFirst({
    where: { id: parsed.data.id, orgId },
    select: { id: true },
  });
  if (!existing) return { ok: false as const, error: 'not-found' as const };

  const data: {
    url?: string;
    description?: string | null;
    enabledEvents?: string[];
    disabledAt?: Date | null;
  } = {};
  if (parsed.data.url !== undefined) {
    const verdict = validateWebhookUrl(parsed.data.url);
    if (!verdict.ok) return { ok: false as const, error: verdict.reason };
    data.url = verdict.url.toString();
  }
  if (parsed.data.description !== undefined) data.description = parsed.data.description;
  if (parsed.data.enabledEvents !== undefined) {
    const eventCheck = rejectUnknownEvents(parsed.data.enabledEvents);
    if (!eventCheck.ok) {
      return { ok: false as const, error: 'unknown-event' as const, bad: eventCheck.bad };
    }
    data.enabledEvents = parsed.data.enabledEvents;
  }
  if (parsed.data.disabledAt !== undefined) data.disabledAt = parsed.data.disabledAt;

  await prisma.webhookEndpoint.update({ where: { id: parsed.data.id }, data });

  logger.info({ actor: me.id, orgId, endpointId: parsed.data.id }, 'webhook-endpoint-updated');
  await recordAudit({
    actorId: me.id,
    orgId,
    action: 'webhook.endpoint_updated',
    target: parsed.data.id,
    metadata: { fields: Object.keys(data) },
  });
  revalidatePath('/settings/organization/webhooks');
  return { ok: true as const };
}

// ─── Delete ─────────────────────────────────────────────────────────────────

export async function deleteWebhookEndpointAction(input: z.infer<typeof idScopeSchema>) {
  const me = await requireUser();
  const parsed = idScopeSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'invalid-input' as const };

  const orgId = await requireWebhookManager(me.id, parsed.data.orgSlug);
  if (!orgId) return { ok: false as const, error: 'forbidden' as const };

  const result = await prisma.webhookEndpoint.deleteMany({
    where: { id: parsed.data.id, orgId },
  });
  if (result.count === 0) return { ok: false as const, error: 'not-found' as const };

  // FK 上的级联处理 WebhookDelivery 行。PR-2 cron
  // 另外翻转转义级联竞争的孤立 PENDING/RETRYING 行到 CANCELED —
  // 安心睡吧。

  logger.info({ actor: me.id, orgId, endpointId: parsed.data.id }, 'webhook-endpoint-deleted');
  await recordAudit({
    actorId: me.id,
    orgId,
    action: 'webhook.endpoint_deleted',
    target: parsed.data.id,
  });
  revalidatePath('/settings/organization/webhooks');
  return { ok: true as const };
}

// ─── Rotate secret ─────────────────────────────────────────────────────────

export async function rotateWebhookSecretAction(input: z.infer<typeof idScopeSchema>) {
  const me = await requireUser();
  const parsed = idScopeSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'invalid-input' as const };

  const orgId = await requireWebhookManager(me.id, parsed.data.orgSlug);
  if (!orgId) return { ok: false as const, error: 'forbidden' as const };

  const fresh = generateWebhookSecret();
  // updateMany 返回 count 而不是 id；提前做 findFirst 保护，所以
  // 我们知道行存在于触及 encSecret 之前（其密钥由
  // id 派生，所以我们需要它）。
  const existing = await prisma.webhookEndpoint.findFirst({
    where: { id: parsed.data.id, orgId },
    select: { id: true },
  });
  if (!existing) return { ok: false as const, error: 'not-found' as const };
  await prisma.webhookEndpoint.update({
    where: { id: existing.id },
    data: {
      secretHash: fresh.hash,
      secretPrefix: fresh.prefix,
      encSecret: fresh.encryptForEndpoint(existing.id),
    },
  });

  logger.info({ actor: me.id, orgId, endpointId: parsed.data.id }, 'webhook-secret-rotated');
  await recordAudit({
    actorId: me.id,
    orgId,
    action: 'webhook.secret_rotated',
    target: parsed.data.id,
  });
  revalidatePath('/settings/organization/webhooks');

  // 明文返回一次 — 与 create 相同的约定。
  return { ok: true as const, secret: fresh.plain, secretPrefix: fresh.prefix };
}

// ─── Resend a delivery ─────────────────────────────────────────────────────

/**
 * RFC 0003 PR-2 — 手动重新排队单个 delivery 行。重置 attempt
 * + 清除终态字段 + 设置 `nextAttemptAt = now()` 以便
 * 下一个 cron tick 拿起它。在任何非 PENDING/RETRYING 行上有效。
 *
 * 用于 DEAD_LETTER 恢复：用户修复了他们的端点并
 * 想要重新播放卡住的事件而不从源再次触发它。
 */
export async function resendWebhookDeliveryAction(input: z.infer<typeof resendSchema>) {
  const me = await requireUser();
  const parsed = resendSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'invalid-input' as const };

  const orgId = await requireWebhookManager(me.id, parsed.data.orgSlug);
  if (!orgId) return { ok: false as const, error: 'forbidden' as const };

  // 防御性双重检查：delivery 必须属于由*此* org 拥有的端点。
  // updateMany 与受约束 where 在单个查询中捕获跨 org 猜测。
  const result = await prisma.webhookDelivery.updateMany({
    where: {
      id: parsed.data.deliveryId,
      endpoint: { id: parsed.data.endpointId, orgId },
    },
    data: {
      status: 'PENDING',
      attempt: 0,
      nextAttemptAt: new Date(),
      responseStatus: null,
      responseBody: null,
      errorMessage: null,
      completedAt: null,
    },
  });
  if (result.count === 0) return { ok: false as const, error: 'not-found' as const };

  logger.info(
    { actor: me.id, orgId, endpointId: parsed.data.endpointId, deliveryId: parsed.data.deliveryId },
    'webhook-delivery-resent',
  );
  revalidatePath(`/settings/organization/webhooks/${parsed.data.endpointId}`);
  return { ok: true as const };
}
