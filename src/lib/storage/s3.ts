import type { StorageProvider } from './types';

/**
 * RFC 0002 PR-3 — S3 provider stub.
 *
 * v1 ships only the env scaffolding + this stub. Wiring the actual SDK is
 * deferred so we don't lock the template into `@aws-sdk/client-s3` (≈3MB
 * install) before someone actually deploys against S3. Mirroring the
 * `src/lib/billing/provider/{stripe,alipay}.ts` convention: empty
 * implementation that throws if accidentally selected.
 *
 * Wiring TODO when going prod against S3:
 *   1. `pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`
 *   2. Replace the throws below with PutObject / GetObject signed URL calls.
 *   3. Configure CORS on the bucket so signed URLs are downloadable from
 *      the browser without a redirect step (or keep redirect: kind === 'redirect').
 */
export class S3Provider implements StorageProvider {
  async put(): Promise<{ key: string; sizeBytes: number }> {
    throw new Error(
      's3-provider-not-implemented — set DATA_EXPORT_STORAGE=local until S3 is wired',
    );
  }

  async resolveDownload(): Promise<{ kind: 'redirect'; url: string }> {
    throw new Error('s3-provider-not-implemented');
  }

  async delete(): Promise<void> {
    // No-op; expired-sweep can run safely against an empty stub.
  }
}
