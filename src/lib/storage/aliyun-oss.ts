// RFC 0006 PR-2 — CN 区域的 Aliyun OSS 存储提供者。
//
// 镜像 `S3Provider` 的形状（PUT 对象、签名 URL 下载、尽力
// 删除）。SDK（`ali-oss`、v6+）在首次使用时*懒加载*，所以
// GLOBAL 区域进程永不导入 OSS 客户端甚至可传递。
//
// 为什么 ali-oss 而不是 S3 兼容接口：
//   - OSS 的 S3 兼容层在 v4 签名 PUT 体 > 1MB 和
//     `x-oss-meta-*` 头命名上有已知问题。原生 SDK 避免
//     那些陷阱。
//   - 一流的 CN 区域端点（`oss-cn-shanghai-internal.aliyuncs
//     .com` 用于 ACK→OSS VPC 流量）仅通过 ali-oss 清晰解析。
//
// 懒 SDK 初始化平行 PR-3 中的 Alipay / WeChat Pay 提供者。

import 'server-only';

import { env } from '@/env';
import { logger } from '@/lib/logger';

import type { StorageProvider } from './types';

// ─── SDK 形状（最小本地视图）────────────────────────────────────────
//
// ali-oss 发布类型但它们在小版本间漂移。我们仅建模
// 我们实际调用的表面；动态导入通过 `unknown` 强制转换
// 所以未来 SDK 升级无法破坏我们的类型检查。

interface OssClientLike {
  put(
    key: string,
    body: Buffer | NodeJS.ReadableStream,
    options?: { headers?: Record<string, string>; mime?: string },
  ): Promise<{ name: string; res: { status: number } }>;

  /** 同步签名 URL 构建器。 */
  signatureUrl(key: string, options: { expires: number; method?: 'GET' | 'PUT' }): string;

  delete(key: string): Promise<{ res: { status: number } }>;
}

interface OssConstructorOptions {
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
  bucket: string;
  /** 覆盖端点（例如内部 VPC 端点）。 */
  endpoint?: string;
  /** 强制 HTTPS。 */
  secure: true;
  /** v4 签名是截至 2026 OSS 仍推荐的唯一。 */
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
      'aliyun-oss-not-configured: ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET / ALIYUN_OSS_BUCKET / ALIYUN_OSS_REGION 必需',
    );
  }

  const mod = await import('ali-oss');
  // ali-oss 是一个 CJS 模块 — `default` 在 ESM 交互中是构造函数
  // 打包程序，模块本身在原始 CJS 下是构造函数。接受
  // 两者，通过 `unknown` 强制转换以保持与 SDK 类型漂移绝缘
  //（cf. RFC 0006 PR-3 wechat.ts 角力）。
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

// ─── 助手 ───────────────────────────────────────────────────────────────

/**
 * 镜像 `S3Provider` 的密钥净化：删除目录组件和
 * 可疑字符，以便调用者可以传递任意 `suggestedKey`
 * 而不逃离桶前缀。
 */
function sanitizeKey(suggestedKey: string): string {
  const basename = suggestedKey.split('/').pop() ?? suggestedKey;
  // 允许字数、dash、dot、underscore。将其他任何替换为 '-'。
  return basename.replace(/[^A-Za-z0-9._-]/g, '-');
}

// ─── 提供者实现 ───────────────────────────────────────────────────

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
      // OSS 侧服务器加密在桶级别默认是开启的
      //（RFC 0006 §4.5）。`x-oss-server-side-encryption` 头强制它
      // 即使未来桶管理员禁用默认。
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
      // 尽力而为：缺失对象上的 404 没问题，为清扫器的审计日志
      // 浮出其他错误。
      logger.warn({ err: error, key }, 'aliyun-oss-delete-failed');
    }
  }
}
