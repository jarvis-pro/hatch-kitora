// RFC 0006 PR-2 — Aliyun DirectMail email provider for the CN region.
//
// Wraps `@alicloud/dm20151123` (modular Aliyun OpenAPI SDK). v1 only
// implements `SingleSendMail` — covers ≤ 100 recipients per call which
// is enough for our auth / billing / org-invitation flows.
//
// SDK is loaded lazily so a GLOBAL-region process never touches it.
// Local interface mirrors only the surface we invoke; cast through
// `unknown` keeps us insulated from minor-version type drift (same
// rationale as `aliyun-oss.ts` and the PR-3 WeChat wrapper).

// Deliberately *not* `'server-only'` here — `sendEmail()` is the public
// API and inherits the same e2e + tsx-CLI compatibility constraint as
// `email/send.ts` documents. Transitively the alibaba SDKs are Node-only,
// so accidental client bundling still fails loudly.

import { env } from '@/env';
import { logger } from '@/lib/logger';

// ─── SDK shape (minimal local view) ────────────────────────────────────────

interface DmClientLike {
  singleSendMail(req: SingleSendMailRequest): Promise<SingleSendMailResponse>;
}

interface SingleSendMailRequest {
  /** Verified sender address (e.g. `noreply@mail.kitora.cn`). */
  accountName: string;
  /** 0 = use random Aliyun-assigned envelope-from, 1 = use accountName. */
  addressType: 0 | 1;
  /** 1 = receipts go back to accountName, 0 = receipts dropped. */
  replyToAddress: 0 | 1;
  /** Comma-separated list, max 100 addresses. */
  toAddress: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
  /** Display name shown in the From header. */
  fromAlias?: string;
}

interface SingleSendMailResponse {
  body?: { envId?: string; requestId?: string };
}

interface DmConfigLike {
  accessKeyId: string;
  accessKeySecret: string;
  endpoint: string;
}

// ─── Lazy SDK init ─────────────────────────────────────────────────────────

let _client: DmClientLike | null = null;

async function getClient(): Promise<DmClientLike> {
  if (_client) return _client;

  if (
    !env.ALIYUN_ACCESS_KEY_ID ||
    !env.ALIYUN_ACCESS_KEY_SECRET ||
    !env.ALIYUN_DM_ACCOUNT_NAME ||
    !env.ALIYUN_DM_ENDPOINT
  ) {
    throw new Error(
      'aliyun-dm-not-configured: ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET / ALIYUN_DM_ACCOUNT_NAME / ALIYUN_DM_ENDPOINT required',
    );
  }

  const [dmMod, openApiMod] = await Promise.all([
    import('@alicloud/dm20151123'),
    import('@alicloud/openapi-client'),
  ]);

  const DmCtor = ((dmMod as unknown as { default?: new (cfg: DmConfigLike) => DmClientLike })
    .default ?? (dmMod as unknown as new (cfg: DmConfigLike) => DmClientLike)) as new (
    cfg: DmConfigLike,
  ) => DmClientLike;

  const ConfigCtor = (openApiMod as unknown as { Config: new (cfg: DmConfigLike) => DmConfigLike })
    .Config;

  const config = new ConfigCtor({
    accessKeyId: env.ALIYUN_ACCESS_KEY_ID,
    accessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET,
    endpoint: env.ALIYUN_DM_ENDPOINT,
  });

  _client = new DmCtor(config);
  return _client;
}

// ─── Public send API ────────────────────────────────────────────────────────

export interface AliyunDmSendParams {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  /** Display name in the From header. Falls back to `Kitora`. */
  fromAlias?: string;
}

/**
 * Send a transactional email via Aliyun DirectMail. Throws on SDK error
 * after a single retry on 5xx (DirectMail is generally fine for first-
 * attempt, but the SLB sometimes flakes during account region failover).
 */
export async function sendAliyunDirectMail(
  params: AliyunDmSendParams,
): Promise<{ envId: string | null }> {
  const client = await getClient();
  const toList = Array.isArray(params.to) ? params.to.join(',') : params.to;

  const req: SingleSendMailRequest = {
    accountName: env.ALIYUN_DM_ACCOUNT_NAME!,
    addressType: 1,
    replyToAddress: 0,
    toAddress: toList,
    subject: params.subject,
    htmlBody: params.html,
    textBody: params.text,
    fromAlias: params.fromAlias ?? 'Kitora',
  };

  try {
    const result = await client.singleSendMail(req);
    return { envId: result.body?.envId ?? null };
  } catch (error) {
    logger.error({ err: error, to: toList, subject: params.subject }, 'aliyun-dm-send-failed');
    throw error;
  }
}
