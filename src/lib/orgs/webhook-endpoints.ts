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
 * RFC 0003 PR-1 — webhook endpoint server actions (CRUD + rotate-secret).
 *
 * Authorization model: every action resolves the org by `orgSlug`, then
 * verifies the caller has an OWNER or ADMIN membership on it. We don't
 * trust the active-org cookie here — the action explicitly takes a slug
 * so the same UI can manage endpoints across orgs without context-switch
 * gymnastics.
 *
 * Secret lifecycle: plaintext is returned only on `create` and on
 * `rotateSecret`. The DB stores `sha256(plain)` + a short `secretPrefix`
 * for UI disambiguation. Lost secrets are not recoverable — users must
 * rotate.
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
  // `null` reactivates a previously disabled endpoint.
  disabledAt: z.union([z.date(), z.null()]).optional(),
});

const idScopeSchema = orgScopeSchema.extend({
  id: z.string().min(1).max(64),
});

/**
 * Verify the caller belongs to the named org with ADMIN or OWNER role.
 * Returns the resolved orgId on success, or null on auth failure.
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

  logger.info({ actor: me.id, orgId, endpointId: endpoint.id }, 'webhook-endpoint-created');
  await recordAudit({
    actorId: me.id,
    orgId,
    action: 'webhook.endpoint_created',
    target: endpoint.id,
    metadata: { url: endpoint.url },
  });
  revalidatePath('/settings/organization/webhooks');

  // The plaintext secret is shown ONCE — caller must surface it in the UI.
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

  // Defensive: confirm the endpoint actually belongs to this org before
  // touching it. Prevents "I'm OWNER of org A, but I'll PATCH endpoint X
  // belonging to org B" by guessing ids.
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

  // Cascade on the FK takes care of WebhookDelivery rows. PR-2 cron
  // additionally flips orphaned PENDING/RETRYING rows that escape the
  // cascade race to CANCELED — sleep tight.

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
  const result = await prisma.webhookEndpoint.updateMany({
    where: { id: parsed.data.id, orgId },
    data: { secretHash: fresh.hash, secretPrefix: fresh.prefix },
  });
  if (result.count === 0) return { ok: false as const, error: 'not-found' as const };

  logger.info({ actor: me.id, orgId, endpointId: parsed.data.id }, 'webhook-secret-rotated');
  await recordAudit({
    actorId: me.id,
    orgId,
    action: 'webhook.secret_rotated',
    target: parsed.data.id,
  });
  revalidatePath('/settings/organization/webhooks');

  // Plaintext returned ONCE — same contract as create.
  return { ok: true as const, secret: fresh.plain, secretPrefix: fresh.prefix };
}
