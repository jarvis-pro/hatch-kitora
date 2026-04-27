/**
 * RFC 0002 PR-3 — 提供者接口。
 *
 * `key` 对调用者是不透明的 — 它是活跃提供者需要
 * 稍后查查文件的任何内容。对于 Local 它是相对路径；对于 S3 它是
 * 对象密钥。调用者在 `DataExportJob.storagePath` 中持久化密钥。
 */
export interface StorageProvider {
  /** 持久化新鲜构建的工件。返回存储密钥。 */
  put(opts: {
    /** 建议的文件名（".../user-123-20260426.zip"）。对于 local 按原样使用；S3 删除 dirname。 */
    suggestedKey: string;
    body: Buffer;
    contentType: string;
  }): Promise<{ key: string; sizeBytes: number }>;

  /**
   * 解析下载 URL。对于 Local 这是 API 下载路由流的相对路径；
   * 对于 S3 它是有效 `ttlSeconds` 的签名 URL。
   */
  resolveDownload(
    key: string,
    ttlSeconds: number,
  ): Promise<{ kind: 'stream' | 'redirect'; url: string }>;

  /** 尽力删除 — 由 EXPIRED sweeper 使用。 */
  delete(key: string): Promise<void>;
}
