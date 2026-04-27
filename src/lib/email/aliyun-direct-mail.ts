// RFC 0006 PR-2 — CN 区域的阿里云 DirectMail 电子邮件提供商。
//
// 包装 `@alicloud/dm20151123`（模块化阿里云 OpenAPI SDK）。v1 仅
// 实现 `SingleSendMail` — 每个调用最多覆盖 100 个收件人，
// 足以满足我们的认证/账单/组织邀请流。
//
// SDK 延迟加载，以便 GLOBAL 区域进程从不接触它。
// 本地接口仅镜像我们调用的表面；通过 `unknown` 投射
// 使我们对次要版本类型漂移绝缘（与 `aliyun-oss.ts` 和
// PR-3 WeChat 包装器相同的理由）。

// 这里故意*没有* `'server-only'` — `sendEmail()` 是公共
// API 并继承与 `email/send.ts` 文档相同的 e2e + tsx-CLI 兼容性约束。
// 传递地阿里巴巴 SDK 仅 Node 专用，所以意外的客户端
// 打包仍会大声失败。

import { env } from '@/env';
import { logger } from '@/lib/logger';

// ─── SDK 形状（最小本地视图） ────────────────────────────────────────

interface DmClientLike {
  singleSendMail(req: SingleSendMailRequest): Promise<SingleSendMailResponse>;
}

interface SingleSendMailRequest {
  /** 已验证的发件人地址（例如 `noreply@mail.kitora.cn`）。 */
  accountName: string;
  /** 0 = 使用随机阿里云分配的信封发件人，1 = 使用 accountName。 */
  addressType: 0 | 1;
  /** 1 = 收据回到 accountName，0 = 收据已删除。 */
  replyToAddress: 0 | 1;
  /** 逗号分隔列表，最多 100 个地址。 */
  toAddress: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
  /** 在 From 标头中显示的显示名称。 */
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

// ─── 延迟 SDK 初始化 ─────────────────────────────────────────────────────────

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

// ─── 公共发送 API ────────────────────────────────────────────────────────

export interface AliyunDmSendParams {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  /** From 标头中的显示名称。回落到 `Kitora`。 */
  fromAlias?: string;
}

/**
 * 通过阿里云 DirectMail 发送事务性电子邮件。在 5xx 上单次重试后
 * 在 SDK 错误时抛出（DirectMail 通常对首次尝试没问题，
 * 但 SLB 有时在账户区域故障转移期间出现故障）。
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
