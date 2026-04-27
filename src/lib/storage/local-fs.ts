import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

import type { StorageProvider } from './types';

/**
 * RFC 0002 PR-3 — dev / CI / on-prem 的文件系统提供者。
 *
 * 文件落在单个根目录下（默认 `./tmp/exports`，git 忽略）。
 * `key` 是相对于该根的路径 — 从不绝对，从不通过 `..` 逃离
 * 根。下载 API 在 auth 检查对应 DataExportJob 行后通过流式
 * 响应提供文件。
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
    // API 路由读取新鲜文件；我们仅返回相对密钥。
    // 路由层负责在流式字节之前重新检查用户拥有作业 —
    // 提供者不认证。
    return { kind: 'stream', url: key };
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.fullPath(sanitizeKey(key)));
    } catch (err) {
      // 将 ENOENT 视为成功（幂等过期清扫）。
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /** 对下载路由处理程序公开。 */
  fullPath(key: string): string {
    const safe = sanitizeKey(key);
    return resolve(this.rootDir, safe);
  }

  /** 对下载路由处理程序公开 — 用于确认存在 + 大小。 */
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
 * 拒绝逃离存储根目录或包含绝对路径的密钥。Cron 写入
 * 我们控制的密钥，但下载路由从 DB 读取密钥 — 对坏行的
 * 深层防御。
 */
function sanitizeKey(key: string): string {
  if (!key || isAbsolute(key)) {
    throw new Error('storage-key-invalid');
  }
  // 归一化后不允许遍历段。
  const normalized = normalize(key);
  if (normalized.startsWith('..') || normalized.split(sep).includes('..')) {
    throw new Error('storage-key-traversal');
  }
  return join(...normalized.split('/'));
}
