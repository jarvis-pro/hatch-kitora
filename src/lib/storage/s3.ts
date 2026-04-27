import type { StorageProvider } from './types';

/**
 * RFC 0002 PR-3 — S3 提供者存根。
 *
 * v1 仅运送 env 脚手架 + 此存根。实际 SDK 的接线
 * 被推迟，所以我们不会在有人实际针对 S3 部署之前将模板锁定
 * 在 `@aws-sdk/client-s3`（≈3MB 安装）。镜像
 * `src/lib/billing/provider/{stripe,alipay}.ts` 约定：空
 * 实现如果意外选择则抛出。
 *
 * 接线 TODO 当针对 S3 进行生产时：
 *   1. `pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`
 *   2. 用 PutObject / GetObject 签名 URL 调用替换下面的 throws。
 *   3. 在桶上配置 CORS 以便签名 URL 可从浏览器下载而无需
 *      重定向步骤（或保持 redirect: kind === 'redirect'）。
 */
export class S3Provider implements StorageProvider {
  async put(): Promise<{ key: string; sizeBytes: number }> {
    throw new Error('s3-provider-not-implemented — 设置 DATA_EXPORT_STORAGE=local 直到 S3 被接线');
  }

  async resolveDownload(): Promise<{ kind: 'redirect'; url: string }> {
    throw new Error('s3-provider-not-implemented');
  }

  async delete(): Promise<void> {
    // 无操作；expired-sweep 可以安全地针对空存根运行。
  }
}
