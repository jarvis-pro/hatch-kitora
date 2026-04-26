import 'server-only';

import { LocalFsProvider } from './local-fs';
import { S3Provider } from './s3';
import type { StorageProvider } from './types';

import { env } from '@/env';

/**
 * RFC 0002 PR-3 — storage facade.
 *
 * The active provider is picked once at module load via env. Callers should
 * always go through `storage` (the singleton) so swapping local→s3 is a
 * single env flip with no code changes.
 *
 * Why a hand-rolled abstraction instead of pulling in `@aws-sdk/client-s3`
 * directly: keeps the Local provider pure-Node (no network on dev / CI),
 * mirrors the billing provider pattern already in `src/lib/billing/provider/`,
 * and gives us a clean seam for testing (LocalFsProvider against a tmp dir).
 */
function makeProvider(): StorageProvider {
  if (env.DATA_EXPORT_STORAGE === 's3') {
    return new S3Provider();
  }
  return new LocalFsProvider(env.DATA_EXPORT_LOCAL_DIR);
}

export const storage: StorageProvider = makeProvider();

export type { StorageProvider } from './types';
