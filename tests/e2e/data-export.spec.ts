import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prisma } from './fixtures/db';
import { expect, test } from './fixtures/test';

import { buildUserExport } from '../../src/lib/data-export/builder';
import { makeZip } from '../../src/lib/data-export/zip';
// Static import — Playwright's TS loader transpiles these but doesn't
// resolve dynamic `import()` calls against `.ts` files (you'd get a raw
// SyntaxError because the transpiler treats the resolved file as CJS).
import { LocalFsProvider } from '../../src/lib/storage/local-fs';

/**
 * RFC 0002 PR-3 — Data export e2e + unit checks.
 *
 * Three flavours of test, kept in one file because they share the prisma
 * fixture lifecycle:
 *
 *   1. Pure-unit zip round-trip — sanity check on the hand-rolled writer.
 *   2. Pure-builder check — calls `buildUserExport()` directly against a
 *      throwaway DB user and asserts the manifest + safe-payload guarantee.
 *   3. UI flow — clicks "Request export" and asserts the row reaches
 *      PENDING; we don't run the cron from inside Playwright (process
 *      isolation), so this stops at "queued" rather than "downloaded".
 */
test.describe('data export', () => {
  test('zip writer round-trips through `unzip` semantics (header parse)', () => {
    const buf = makeZip([
      { name: 'a.json', body: Buffer.from('{"hello":"world"}') },
      { name: 'b.txt', body: Buffer.from('plain text body') },
    ]);
    // EOCD signature should appear once near the end of the buffer.
    const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    expect(buf.indexOf(eocdSig)).toBeGreaterThan(0);
    // Local-file-header signature appears at offset 0.
    expect(buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
  });

  test('builder produces a manifest + the expected file set', async ({ testUser }) => {
    const result = await buildUserExport(testUser.id);
    expect(result.filename).toMatch(/^kitora-export-.+-\d{8}\.zip$/);
    expect(result.body.length).toBeGreaterThan(50);

    // Cross-reference against the file names embedded in the central
    // directory entries — search for any of the JSON file names we expect.
    const text = result.body.toString('binary');
    for (const expected of [
      'manifest.json',
      'profile.json',
      'accounts.json',
      'memberships.json',
      'api-tokens.json',
      'audit-as-actor.json',
      'device-sessions.json',
      'data-exports.json',
      'README.md',
    ]) {
      expect(text).toContain(expected);
    }

    // Sensitive blacklist must NEVER appear, even though the user has a
    // password hash in the DB.
    for (const term of ['passwordHash', 'tokenHash', 'sidHash', 'encSecret', 'backupHashes']) {
      expect(text).not.toContain(`"${term}"`);
    }
  });

  test('UI request enqueues a PENDING job for the current user', async ({
    page,
    testUser,
    signIn,
  }) => {
    await signIn(page, testUser);
    await page.goto('/settings');

    // Use the "Request export" button under the data-export card.
    const btn = page.getByRole('button', { name: /^request export$/i });
    await expect(btn).toBeVisible();
    await btn.click();

    // Toast surfaces the queued message; pollable DB state is the truth.
    await page.waitForTimeout(300);
    const job = await prisma.dataExportJob.findFirst({
      where: { userId: testUser.id, scope: 'USER' },
      orderBy: { createdAt: 'desc' },
    });
    expect(job).not.toBeNull();
    expect(job?.status).toBe('PENDING');

    // Cleanup — delete the row so the user fixture's deleteUser cascade has
    // a clean slate (DataExportJob has no FK on userId, so cascade won't
    // touch it).
    if (job) {
      await prisma.dataExportJob.delete({ where: { id: job.id } });
    }
  });

  test('local storage round-trip — write then re-read matches', async () => {
    // Spot-check the LocalFsProvider against an isolated tmp dir, sidestepping
    // the singleton in src/lib/storage/index.ts.
    const root = mkdtempSync(join(tmpdir(), 'kitora-export-'));
    try {
      const provider = new LocalFsProvider(root);
      const body = Buffer.from('hello-export-world');
      const { key, sizeBytes } = await provider.put({
        suggestedKey: 'sub/dir/foo.zip',
        body,
        contentType: 'application/zip',
      });
      expect(sizeBytes).toBe(body.length);
      const onDisk = readFileSync(provider.fullPath(key));
      expect(onDisk.equals(body)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('storage rejects path traversal in keys', async () => {
    const provider = new LocalFsProvider('/tmp/whatever');
    await expect(
      provider.put({ suggestedKey: '../escape.zip', body: Buffer.alloc(1), contentType: 'a/b' }),
    ).rejects.toThrow(/traversal|invalid/);
  });
});
