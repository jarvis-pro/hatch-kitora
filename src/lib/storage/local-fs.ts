import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

import type { StorageProvider } from './types';

/**
 * RFC 0002 PR-3 — filesystem provider for dev / CI / on-prem.
 *
 * Files land under a single root dir (default `./tmp/exports`, git-ignored).
 * `key` is a path relative to that root — never absolute, never escaping
 * the root via `..`. The download API serves files via a streamed Response
 * after auth-checking the corresponding DataExportJob row.
 */
export class LocalFsProvider implements StorageProvider {
  constructor(private readonly rootDir: string) {}

  async put({
    suggestedKey,
    body,
  }: {
    suggestedKey: string;
    body: Buffer;
    contentType: string;
  }): Promise<{ key: string; sizeBytes: number }> {
    const key = sanitizeKey(suggestedKey);
    const fullPath = this.fullPath(key);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, body);
    return { key, sizeBytes: body.byteLength };
  }

  async resolveDownload(key: string): Promise<{ kind: 'stream'; url: string }> {
    // The API route reads the file fresh; we only return the relative key.
    // The route layer is responsible for re-checking the user owns the job
    // before streaming bytes — provider doesn't authenticate.
    return { kind: 'stream', url: key };
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.fullPath(sanitizeKey(key)));
    } catch (err) {
      // Treat ENOENT as success (idempotent expiry sweeps).
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /** Public for the download route handler. */
  fullPath(key: string): string {
    const safe = sanitizeKey(key);
    return resolve(this.rootDir, safe);
  }

  /** Public for the download route handler — used to confirm existence + size. */
  async statKey(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const s = await stat(this.fullPath(key));
      return { sizeBytes: s.size };
    } catch {
      return null;
    }
  }
}

/**
 * Reject keys that escape the storage root or contain absolute paths.
 * The cron writes keys we control, but the download route reads keys from
 * the DB — defense-in-depth against a stray bad row.
 */
function sanitizeKey(key: string): string {
  if (!key || isAbsolute(key)) {
    throw new Error('storage-key-invalid');
  }
  // Disallow traversal segments after normalisation.
  const normalized = normalize(key);
  if (normalized.startsWith('..') || normalized.split(sep).includes('..')) {
    throw new Error('storage-key-traversal');
  }
  return join(...normalized.split('/'));
}
