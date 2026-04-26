// RFC 0006 PR-2 — Aliyun OSS storage provider for the CN region.
//
// Mirrors `S3Provider` in shape (PUT object, signed-URL download, best-
// effort delete). The SDK (`ali-oss`, v6+) is loaded *lazily* on first
// use so a GLOBAL-region process never imports the OSS client even
// transitively.
//
// Why ali-oss not the S3-compatible interface:
//   - OSS's S3 compatibility layer has known quirks around v4 signing of
//     PUT bodies > 1MB and around `x-oss-meta-*` header naming. Native
//     SDK avoids those gotchas.
//   - First-class CN region endpoints (`oss-cn-shanghai-internal.aliyuncs
//     .com` for ACK→OSS VPC traffic) only resolve cleanly through ali-oss.
//
// Lazy SDK init parallels the Alipay / WeChat Pay providers in PR-3.

import 'server-only';

import { env } from '@/env';
import { logger } from '@/lib/logger';

import type { StorageProvider } from './types';

// ─── SDK shape (minimal local view) ────────────────────────────────────────
//
// ali-oss publishes types but they drift across minor versions. We model
// only the surface we actually invoke; the dynamic import casts through
// `unknown` so a future SDK upgrade can't break our typecheck.

interface OssClientLike {
  put(
    key: string,
    body: Buffer | NodeJS.ReadableStream,
    options?: { headers?: Record<string, string>; mime?: string },
  ): Promise<{ name: string; res: { status: number } }>;

  /** Synchronous signed-URL builder. */
  signatureUrl(key: string, options: { expires: number; method?: 'GET' | 'PUT' }): string;

  delete(key: string): Promise<{ res: { status: number } }>;
}

interface OssConstructorOptions {
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
  bucket: string;
  /** Override endpoint (e.g. internal VPC endpoint). */
  endpoint?: string;
  /** Force HTTPS. */
  secure: true;
  /** v4 signature is the only one OSS still recommends as of 2026. */
  authorizationV4: true;
}

let _client: OssClientLike | null = null;

async function getClient(): Promise<OssClientLike> {
  if (_client) return _client;

  if (
    !env.ALIYUN_ACCESS_KEY_ID ||
    !env.ALIYUN_ACCESS_KEY_SECRET ||
    !env.ALIYUN_OSS_BUCKET ||
    !env.ALIYUN_OSS_REGION
  ) {
    throw new Error(
      'aliyun-oss-not-configured: ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET / ALIYUN_OSS_BUCKET / ALIYUN_OSS_REGION required',
    );
  }

  const mod = await import('ali-oss');
  // ali-oss is a CJS module — `default` is the constructor in ESM-interop
  // bundlers, the module itself is the constructor under raw CJS. Accept
  // both, cast through `unknown` to stay insulated from SDK type drift
  // (cf. RFC 0006 PR-3 wechat.ts wrestle).
  const Ctor = ((mod as unknown as { default?: new (cfg: OssConstructorOptions) => OssClientLike })
    .default ?? (mod as unknown as new (cfg: OssConstructorOptions) => OssClientLike)) as new (
    cfg: OssConstructorOptions,
  ) => OssClientLike;

  _client = new Ctor({
    accessKeyId: env.ALIYUN_ACCESS_KEY_ID,
    accessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET,
    region: env.ALIYUN_OSS_REGION,
    bucket: env.ALIYUN_OSS_BUCKET,
    endpoint: env.ALIYUN_OSS_ENDPOINT,
    secure: true,
    authorizationV4: true,
  });

  return _client;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Mirror `S3Provider`'s key sanitisation: strip directory components and
 * suspicious characters so callers can pass arbitrary `suggestedKey`s
 * without escaping the bucket prefix.
 */
function sanitizeKey(suggestedKey: string): string {
  const basename = suggestedKey.split('/').pop() ?? suggestedKey;
  // Allow alnum, dash, dot, underscore. Replace anything else with '-'.
  return basename.replace(/[^A-Za-z0-9._-]/g, '-');
}

// ─── Provider implementation ───────────────────────────────────────────────

export class AliyunOssProvider implements StorageProvider {
  async put({
    suggestedKey,
    body,
    contentType,
  }: {
    suggestedKey: string;
    body: Buffer;
    contentType: string;
  }): Promise<{ key: string; sizeBytes: number }> {
    const key = sanitizeKey(suggestedKey);
    const client = await getClient();
    const result = await client.put(key, body, {
      mime: contentType,
      // OSS-side server encryption is on by default at the bucket level
      // (RFC 0006 §4.5). `x-oss-server-side-encryption` header forces it
      // even if a future bucket admin disables the default.
      headers: { 'x-oss-server-side-encryption': 'AES256' },
    });
    if (result.res.status !== 200) {
      logger.error({ key, status: result.res.status }, 'aliyun-oss-put-non-200');
      throw new Error(`aliyun-oss-put-status-${result.res.status}`);
    }
    return { key, sizeBytes: body.byteLength };
  }

  async resolveDownload(
    key: string,
    ttlSeconds: number,
  ): Promise<{ kind: 'redirect'; url: string }> {
    const client = await getClient();
    const url = client.signatureUrl(key, { expires: ttlSeconds, method: 'GET' });
    return { kind: 'redirect', url };
  }

  async delete(key: string): Promise<void> {
    const client = await getClient();
    try {
      await client.delete(key);
    } catch (error) {
      // Best-effort: 404s on a missing object are fine, surface other
      // errors for the sweeper's audit log.
      logger.warn({ err: error, key }, 'aliyun-oss-delete-failed');
    }
  }
}
