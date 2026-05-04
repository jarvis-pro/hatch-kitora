import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createOrgWithOwner, createTestUser, deleteOrg, deleteUser, prisma } from './fixtures/db';
import { expect, test } from '@playwright/test';

import { runWebhookCronTick } from '../../src/services/webhooks/cron';
import { generateWebhookSecret } from '../../src/services/webhooks/secret';

/**
 * RFC 0003 PR-4 — 自动禁用 + sweep e2e。
 *
 * 通过预置 `consecutiveFailures = THRESHOLD - 1` 并将一次投递路由到
 * 502 接收方，确定性地触发阈值。cron tick 后预期：
 *
 *   - endpoint.disabledAt 已设置
 *   - 审计行携带 `webhook.endpoint_auto_disabled`（actor 为 null）
 *   - 投递行进入 DEAD_LETTER（第 8 次是上限）
 *
 * 邮件发送在上游被 try/catch 包裹，因此即使没有配置 Resend，
 * 测试也能通过 —— 我们只是不对邮件做断言。
 */

const THRESHOLD = 8; // mirror cron.ts AUTO_DISABLE_THRESHOLD

async function with502Receiver(fn: (url: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, body: body.slice(0, 100) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/hooks`;
  try {
    await fn(url);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test.describe('webhook auto-disable (PR-4)', () => {
  test('crossing the failure threshold flips disabledAt + writes audit', async () => {
    const owner = await createTestUser({ emailVerified: true });
    const slug = `wh-disable-${Date.now()}`;
    const org = await createOrgWithOwner({ ownerId: owner.id, slug });

    try {
      await with502Receiver(async (url) => {
        const secret = generateWebhookSecret();
        const ep = await prisma.webhookEndpoint.create({
          data: {
            orgId: org.id,
            url,
            enabledEvents: ['audit.recorded'],
            secretHash: secret.hash,
            secretPrefix: secret.prefix,
            // Pre-seed at threshold-1 so a single failed delivery flips it.
            // The retry curve has the 8th attempt as the dead-letter, so we
            // need attempt = THRESHOLD - 1 already attempted to land on the
            // exact threshold. Skip the long curve by pre-seeding directly.
            consecutiveFailures: THRESHOLD - 1,
          },
          select: { id: true },
        });
        await prisma.webhookEndpoint.update({
          where: { id: ep.id },
          data: { encSecret: secret.encryptForEndpoint(ep.id) },
        });

        // One delivery row, due now. cron will pick it, fetch the 502,
        // schedule a retry on attempt 1, increment failures.
        await prisma.webhookDelivery.create({
          data: {
            endpointId: ep.id,
            eventId: 'evt_disable_1',
            eventType: 'audit.recorded',
            payload: {
              id: 'evt_disable_1',
              type: 'audit.recorded',
              data: {},
            },
            status: 'PENDING',
            nextAttemptAt: new Date(),
          },
        });

        await runWebhookCronTick();
        // Settle on filesystem / network IO before reading.
        await new Promise((r) => setTimeout(r, 100));

        const after = await prisma.webhookEndpoint.findUniqueOrThrow({
          where: { id: ep.id },
          select: {
            disabledAt: true,
            consecutiveFailures: true,
          },
        });
        expect(after.disabledAt).not.toBeNull();
        expect(after.consecutiveFailures).toBeGreaterThanOrEqual(THRESHOLD);

        const audit = await prisma.auditLog.findFirst({
          where: {
            orgId: org.id,
            action: 'webhook.endpoint_auto_disabled',
            target: ep.id,
          },
          select: { actorId: true, metadata: true },
        });
        expect(audit).not.toBeNull();
        // Auto-disable is a system action — no actor.
        expect(audit?.actorId).toBeNull();
      });
    } finally {
      await deleteOrg(org.id).catch(() => undefined);
      await deleteUser(owner.id).catch(() => undefined);
    }
  });

  test('terminal-state sweep deletes deliveries past the retention window', async () => {
    const owner = await createTestUser({ emailVerified: true });
    const slug = `wh-sweep-${Date.now()}`;
    const org = await createOrgWithOwner({ ownerId: owner.id, slug });

    try {
      const secret = generateWebhookSecret();
      const ep = await prisma.webhookEndpoint.create({
        data: {
          orgId: org.id,
          url: 'https://example.invalid/hooks', // never fetched
          enabledEvents: [],
          secretHash: secret.hash,
          secretPrefix: secret.prefix,
        },
        select: { id: true },
      });
      await prisma.webhookEndpoint.update({
        where: { id: ep.id },
        data: { encSecret: secret.encryptForEndpoint(ep.id) },
      });

      const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      const recent = new Date(Date.now() - 1 * 60 * 60 * 1000);

      // Two terminal rows: one stale (> 30d), one fresh.
      const stale = await prisma.webhookDelivery.create({
        data: {
          endpointId: ep.id,
          eventId: 'evt_sweep_old',
          eventType: 'audit.recorded',
          payload: {},
          status: 'DELIVERED',
          completedAt: longAgo,
          // Backdate createdAt too so any OR fallback doesn't preserve it.
          createdAt: longAgo,
        },
        select: { id: true },
      });
      const fresh = await prisma.webhookDelivery.create({
        data: {
          endpointId: ep.id,
          eventId: 'evt_sweep_new',
          eventType: 'audit.recorded',
          payload: {},
          status: 'DELIVERED',
          completedAt: recent,
        },
        select: { id: true },
      });

      await runWebhookCronTick();

      const survivors = await prisma.webhookDelivery.findMany({
        where: { endpointId: ep.id },
        select: { id: true },
      });
      const surviving = new Set(survivors.map((s) => s.id));
      expect(surviving.has(fresh.id)).toBe(true);
      expect(surviving.has(stale.id)).toBe(false);
    } finally {
      await deleteOrg(org.id).catch(() => undefined);
      await deleteUser(owner.id).catch(() => undefined);
    }
  });
});
