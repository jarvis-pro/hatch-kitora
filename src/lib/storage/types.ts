/**
 * RFC 0002 PR-3 — provider interface.
 *
 * `key` is opaque to the caller — it's whatever the active provider needs
 * to look the file up later. For Local it's a relative path; for S3 it's
 * the object key. Callers persist the key in `DataExportJob.storagePath`.
 */
export interface StorageProvider {
  /** Persist a freshly built artefact. Returns the storage key. */
  put(opts: {
    /** Suggested filename (".../user-123-20260426.zip"). Used as-is for local; S3 strips the dirname. */
    suggestedKey: string;
    body: Buffer;
    contentType: string;
  }): Promise<{ key: string; sizeBytes: number }>;

  /**
   * Resolve a download URL. For Local this is a relative path the API
   * download route streams; for S3 it's a signed URL valid for `ttlSeconds`.
   */
  resolveDownload(
    key: string,
    ttlSeconds: number,
  ): Promise<{ kind: 'stream' | 'redirect'; url: string }>;

  /** Best-effort delete — used by the EXPIRED sweeper. */
  delete(key: string): Promise<void>;
}
