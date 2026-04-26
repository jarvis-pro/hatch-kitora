import 'server-only';

import { AliyunOssProvider } from './aliyun-oss';
import { LocalFsProvider } from './local-fs';
import { S3Provider } from './s3';
import type { StorageProvider } from './types';

import { env } from '@/env';
import { isCnRegion } from '@/lib/region';

/**
 * RFC 0002 PR-3 — storage facade.
 *
 * The active provider is picked once at module load. Callers always go
 * through `storage` (the singleton) so swapping providers is a single
 * env flip with no code changes.
 *
 * RFC 0006 PR-2 — region wins over `DATA_EXPORT_STORAGE`. A CN-region
 * deploy MUST land objects in Aliyun OSS regardless of the legacy env
 * flag (PIPL §39 — "store within China"). Outside CN, the historical
 * `DATA_EXPORT_STORAGE` env still toggles between local-fs and S3.
 *
 * Why a hand-rolled abstraction instead of pulling in `@aws-sdk/client-s3`
 * directly: keeps the Local provider pure-Node (no network on dev / CI),
 * mirrors the billing provider pattern in `src/lib/billing/provider/`,
 * and gives us a clean seam for testing (LocalFsProvider against a tmp dir).
 */
function makeProvider(): StorageProvider {
  if (isCnRegion()) {
    return new AliyunOssProvider();
  }
  if (env.DATA_EXPORT_STORAGE === 's3') {
    return new S3Provider();
  }
  return new LocalFsProvider(env.DATA_EXPORT_LOCAL_DIR);
}

export const storage: StorageProvider = makeProvider();

export type { StorageProvider } from './types';
