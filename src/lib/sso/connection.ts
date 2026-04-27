// 注意：这里刻意*不*设置 'server-only' — server action、route
// handler 和（最终）e2e fixtures 都导入此适配器。可传递的
// `@boxyhq/saml-jackson` 导入仅是 Node。
//
// 在 `IdentityProvider` 行和 `@boxyhq/saml-jackson` 连接之间的
// 薄同步层。Jackson 在其 `jackson_*` 表中存储已解析 SAML 元数据/
// OIDC discovery 载荷的自己副本；我们在 `IdentityProvider` 中
// 拥有面向用户的行并在每次写入时重新推送到 Jackson，所以两个
// 视图永不漂移。
//
// 租约合约：
//
//   tenant  = organization slug（UTF-8，URL 安全）
//   product = JACKSON_PRODUCT（常量 — 单产品安装）
//
// `getConnections({ tenant, product })` 最多返回一个 SAML 和一个
// OIDC 连接 — Jackson 允许每个（tenant, product）有 N 个，但我们
// `IdentityProvider` `@@unique([orgId, protocol])` 将其折叠为两个。

import { env } from '@/env';

import { JACKSON_PRODUCT, getConnectionController } from './jackson';

export interface SamlSyncInput {
  /** Organization slug — 用作 Jackson tenant。 */
  orgSlug: string;
  /** 原始 IdP 元数据 XML。 */
  samlMetadata: string;
}

export interface OidcSyncInput {
  orgSlug: string;
  oidcIssuer: string;
  oidcClientId: string;
  /** 明文 OIDC client_secret。未由 Jackson 以明文形式持久化 —
   *  Jackson 用其自己的密钥加密静态。我们在每次更新时重新传递。 */
  oidcClientSecret: string;
}

function defaultRedirectUrl(): string {
  return `${env.NEXT_PUBLIC_APP_URL}/dashboard`;
}

function allowedRedirectUrls(): string {
  // Jackson 期望 JSON 编码的允许重定向 URI 前缀数组。
  // 我们只在我们自己的应用中着陆，所以单个主机足够。
  return JSON.stringify([env.NEXT_PUBLIC_APP_URL]);
}

/**
 * Upsert 一个 SAML 连接。如果此租户已存在 SAML 行，我们删除 + 重新创建
 *（Jackson 的 `updateSAMLConnection` 需要预先存在的 `clientID` + `clientSecret`，
 * 而我们不跟踪它们 — 删除+创建是幂等的并且同样便宜）。
 */
export async function syncSamlConnection(input: SamlSyncInput): Promise<void> {
  const ctrl = await getConnectionController();
  const existing = await ctrl.getConnections({
    tenant: input.orgSlug,
    product: JACKSON_PRODUCT,
  });
  // 删除同一租户下的任何预先存在的 SAML 行。Jackson 由 clientID
  // 键入；传递相同元数据两次将创建重复项。(SAMLSSORecord | OIDCSSORecord)
  // 联合没有共享 `protocol` 字段 — 通过设置哪个记录形状字段
  // 来区分。
  for (const c of existing) {
    if ('idpMetadata' in c) {
      await ctrl.deleteConnections({
        clientID: c.clientID,
        clientSecret: c.clientSecret,
      });
    }
  }
  await ctrl.createSAMLConnection({
    rawMetadata: input.samlMetadata,
    defaultRedirectUrl: defaultRedirectUrl(),
    redirectUrl: allowedRedirectUrls(),
    tenant: input.orgSlug,
    product: JACKSON_PRODUCT,
  });
}

/**
 * Upsert 一个 OIDC 连接。与 `syncSamlConnection` 相同的删除+重新创建
 * 模式出于相同的原因。
 */
export async function syncOidcConnection(input: OidcSyncInput): Promise<void> {
  const ctrl = await getConnectionController();
  const existing = await ctrl.getConnections({
    tenant: input.orgSlug,
    product: JACKSON_PRODUCT,
  });
  for (const c of existing) {
    // OIDC 记录携带 `oidcProvider`；SAML 记录不。
    if ('oidcProvider' in c) {
      await ctrl.deleteConnections({
        clientID: c.clientID,
        clientSecret: c.clientSecret,
      });
    }
  }
  await ctrl.createOIDCConnection({
    oidcDiscoveryUrl: `${input.oidcIssuer.replace(/\/+$/, '')}/.well-known/openid-configuration`,
    oidcClientId: input.oidcClientId,
    oidcClientSecret: input.oidcClientSecret,
    defaultRedirectUrl: defaultRedirectUrl(),
    redirectUrl: allowedRedirectUrls(),
    tenant: input.orgSlug,
    product: JACKSON_PRODUCT,
  });
}

/** 删除租户下的每个连接 — 在 IdP 删除 + org 删除时使用。 */
export async function removeConnections(orgSlug: string): Promise<void> {
  const ctrl = await getConnectionController();
  const existing = await ctrl.getConnections({
    tenant: orgSlug,
    product: JACKSON_PRODUCT,
  });
  for (const c of existing) {
    await ctrl.deleteConnections({
      clientID: c.clientID,
      clientSecret: c.clientSecret,
    });
  }
}
