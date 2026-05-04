import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createOrgWithOwner, createTestUser, deleteOrg, deleteUser, prisma } from './fixtures/db';
import { expect, test } from './fixtures/test';

import { runWebhookCronTick } from '../../src/services/webhooks/cron';
import { deliverWebhook } from '../../src/services/webhooks/deliver';
import {
  decryptSecret,
  encryptSecret,
  generateWebhookSecret,
} from '../../src/services/webhooks/secret';
import { signWebhookPayload, verifyWebhookSignature } from '../../src/services/webhooks/sign';

/**
 * RFC 0003 PR-2 — 出站投递 + HMAC e2e。
 *
 * 启动一个本地 http 服务器捕获请求体和请求头，让 deliverWebhook
 * 辅助函数向其 POST，然后断言接收方拿到了有效签名和正确的请求头。
 * 绕过 cron + DB（它们依赖 Prisma codegen，在别处做了单测）——
 * 本 slice 测试真实 socket 上的实际 fetch + 签名路径。
 */

interface Captured {
  headers: Record<string, string>;
  body: string;
}

async function withReceiver(
  status: number,
  fn: (url: string, captured: Captured[]) => Promise<void>,
): Promise<void> {
  const captured: Captured[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
      }
      captured.push({ headers, body });
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ack: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/hooks`;
  try {
    await fn(url, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test.describe('webhook delivery (PR-2)', () => {
  test('signWebhookPayload + verifyWebhookSignature roundtrip', () => {
    const secret = 'whsec_' + 'a'.repeat(43);
    const body = JSON.stringify({ id: 'evt_xyz', type: 'subscription.updated', data: { foo: 1 } });
    const { signature, timestamp } = signWebhookPayload({ secret, body });
    const verdict = verifyWebhookSignature({ secret, header: signature, body });
    expect(verdict.ok).toBe(true);
    expect(timestamp).toBeGreaterThan(0);

    // Tampered body fails.
    const tampered = verifyWebhookSignature({ secret, header: signature, body: body + 'x' });
    expect(tampered.ok).toBe(false);

    // Replay-window enforcement.
    const stale = signWebhookPayload({ secret, body, timestamp: 1 });
    const expired = verifyWebhookSignature({ secret, header: stale.signature, body });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.reason).toBe('expired');
  });

  test('deliverWebhook signs body + receiver verifies + retry on 5xx', async () => {
    // 200 path
    await withReceiver(200, async (url, captured) => {
      const secret = generateWebhookSecret();
      const result = await deliverWebhook({
        url,
        secret: secret.plain,
        eventId: 'evt_test_1',
        eventType: 'subscription.created',
        payload: { id: 'evt_test_1', type: 'subscription.created', data: { hello: 'world' } },
        attempt: 1,
      });
      expect(result.kind).toBe('delivered');
      expect(captured.length).toBe(1);
      const got = captured[0]!;
      expect(got.headers['x-kitora-event-id']).toBe('evt_test_1');
      expect(got.headers['x-kitora-event-type']).toBe('subscription.created');
      expect(got.headers['x-kitora-signature']).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
      const verdict = verifyWebhookSignature({
        secret: secret.plain,
        header: got.headers['x-kitora-signature']!,
        body: got.body,
      });
      expect(verdict.ok).toBe(true);
    });

    // 502 path → retry scheduled
    await withReceiver(502, async (url) => {
      const secret = generateWebhookSecret();
      const result = await deliverWebhook({
        url,
        secret: secret.plain,
        eventId: 'evt_test_2',
        eventType: 'audit.recorded',
        payload: { id: 'evt_test_2', type: 'audit.recorded', data: {} },
        attempt: 1,
      });
      expect(result.kind).toBe('retry');
      if (result.kind === 'retry') expect(result.delayMs).toBeGreaterThan(0);
    });

    // 400 path → dead letter immediately
    await withReceiver(400, async (url) => {
      const secret = generateWebhookSecret();
      const result = await deliverWebhook({
        url,
        secret: secret.plain,
        eventId: 'evt_test_3',
        eventType: 'audit.recorded',
        payload: { id: 'evt_test_3', type: 'audit.recorded', data: {} },
        attempt: 1,
      });
      expect(result.kind).toBe('dead-letter');
    });
  });

  test('encryptSecret + decryptSecret round-trip per endpoint id', () => {
    // The cron flow round-trips a secret through DB-stored ciphertext;
    // verify the helper isn't accidentally lossy.
    const plain = 'whsec_' + 'b'.repeat(43);
    const ciphertext = encryptSecret('endpoint-abc', plain);
    expect(ciphertext.length).toBeGreaterThan(plain.length); // grew with iv+tag

    const round = encryptSecret('endpoint-abc', plain);
    expect(round.equals(ciphertext)).toBe(false); // randomised iv

    expect(decryptSecret('endpoint-abc', ciphertext)).toBe(plain);
  });

  test('typed subscription event lands as DELIVERED row when cron-side enqueue fires', async ({
    signIn,
    page,
  }) => {
    // Create owner + org + endpoint with the typed event subscribed.
    const owner = await createTestUser({ emailVerified: true });
    const slug = `wh-deliver-${Date.now()}`;
    const org = await createOrgWithOwner({ ownerId: owner.id, slug });

    try {
      // Insert an endpoint that the test will route deliveries through.
      // We use prisma directly so the test doesn't have to drive the form
      // (covered by webhooks.spec.ts).
      await withReceiver(200, async (url) => {
        const secret = generateWebhookSecret();
        const ep = await prisma.webhookEndpoint.create({
          data: {
            orgId: org.id,
            url,
            enabledEvents: ['subscription.created'],
            secretHash: secret.hash,
            secretPrefix: secret.prefix,
          },
          select: { id: true },
        });
        await prisma.webhookEndpoint.update({
          where: { id: ep.id },
          data: { encSecret: secret.encryptForEndpoint(ep.id) },
        });

        // Hand-craft a delivery row pointing at the receiver (skipping
        // enqueueWebhook to avoid coupling this test to the audit bridge).
        await prisma.webhookDelivery.create({
          data: {
            endpointId: ep.id,
            eventId: 'evt_e2e_1',
            eventType: 'subscription.created',
            payload: {
              id: 'evt_e2e_1',
              type: 'subscription.created',
              createdAt: new Date().toISOString(),
              data: { status: 'active' },
            },
            status: 'PENDING',
            nextAttemptAt: new Date(),
          },
        });

        // Run the cron in-process. We import the library form
        // (`runWebhookCronTick`) statically so Playwright + tsx don't
        // disagree on the script's module type — the CLI wrapper at
        // `scripts/run-webhook-cron.ts` is just a thin shell around this.
        await runWebhookCronTick();
        // Give a tick for I/O to settle.
        await new Promise((r) => setTimeout(r, 50));

        const after = await prisma.webhookDelivery.findFirst({
          where: { endpointId: ep.id, eventId: 'evt_e2e_1' },
          select: { status: true, responseStatus: true, attempt: true },
        });
        expect(after?.status).toBe('DELIVERED');
        expect(after?.responseStatus).toBe(200);
        expect(after?.attempt).toBeGreaterThanOrEqual(1);

        // Don't bother with the dashboard UI assertion here — the
        // webhooks.spec.ts e2e covers the page render. Just sign in
        // briefly so signIn fixture is exercised.
        await signIn(page, owner);
      });
    } finally {
      await deleteOrg(org.id).catch(() => undefined);
      await deleteUser(owner.id).catch(() => undefined);
    }
  });
});
