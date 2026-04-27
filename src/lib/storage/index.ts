import 'server-only';

import { AliyunOssProvider } from './aliyun-oss';
import { LocalFsProvider } from './local-fs';
import { S3Provider } from './s3';
import type { StorageProvider } from './types';

import { env } from '@/env';
import { isCnRegion } from '@/lib/region';

/**
 * RFC 0002 PR-3 — 存储门面。
 *
 * 活跃提供者在模块加载时选择一次。调用者总是通过 `storage`
 *（单例）去，所以交换提供者是单个 env 翻转，无需代码更改。
 *
 * RFC 0006 PR-2 — 区域超过 `DATA_EXPORT_STORAGE`。CN 区域部署
 * 必须无论旧 env 标志如何都在 Aliyun OSS 中着陆对象
 *（PIPL §39 — "存储在中国内"）。CN 外，历史 `DATA_EXPORT_STORAGE`
 * env 仍在本地 fs 和 S3 之间切换。
 *
 * 为什么是手工制作抽象而不是直接拉入 `@aws-sdk/client-s3`：
 * 保持 Local 提供者纯 Node（dev / CI 上无网络），镜像
 * `src/lib/billing/provider/` 中的计费提供者模式，
 * 并为我们提供清洁的测试接缝（LocalFsProvider 针对 tmp dir）。
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
