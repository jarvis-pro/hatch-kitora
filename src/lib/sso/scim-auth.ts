// 注意：这里刻意*不*设置 'server-only' — 每个 SCIM 路由 + e2e
// 套件都使用这个。可传递 `@/lib/db`（prisma）把守意外的
// 客户端打包。
//
// SCIM Bearer 认证助手。Token 通过 `rotateScimTokenAction`（RFC 0004 PR-1）
// 发出并存在于 `IdentityProvider.scimTokenHash` 中作为 `sha256(plaintext)`。
// 我们永不存储明文；在每个 SCIM 请求上调用者的
// `Authorization: Bearer scim_…` 头被哈希并针对该索引查询。
//
// 返回已解析的 `(idpId, orgId)` 以便路由处理程序可以限定
// 读取 + 写入到同一租户 — 对一个 org 发出的 token
// 永不能意外配置到另一个。

import { prisma } from '@/lib/db';
import { currentRegion } from '@/lib/region';
import { hashScimToken } from '@/lib/sso/secret';

export type ScimAuthResult =
  | { ok: true; idpId: string; orgId: string; orgSlug: string }
  | { ok: false; status: 401 | 403; reason: string };

export async function authenticateScim(request: Request): Promise<ScimAuthResult> {
  const auth = request.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return { ok: false, status: 401, reason: 'missing-bearer' };
  }
  const token = auth.slice('Bearer '.length).trim();
  if (!token.startsWith('scim_')) {
    return { ok: false, status: 401, reason: 'malformed-token' };
  }

  const hash = hashScimToken(token);
  const idp = await prisma.identityProvider.findUnique({
    where: { scimTokenHash: hash },
    select: {
      id: true,
      orgId: true,
      scimEnabled: true,
      organization: { select: { slug: true, region: true } },
    },
  });
  if (!idp) {
    return { ok: false, status: 401, reason: 'token-not-found' };
  }
  if (!idp.scimEnabled) {
    // Token 被轮换以禁用但尚未撤销？无论如何拒绝 —
    // IT 操作者负责在他们的 IdP 中轮换。
    return { ok: false, status: 403, reason: 'scim-disabled' };
  }
  // RFC 0005 §5 — SCIM token 按区域绑定。Token 哈希存在于
  // 该区域自己的 DB，所以到达此点已暗示相同区域；我们
  // 仍然交叉检查 `currentRegion()` 以便配置错误的堆栈无法
  // 接受它不应该的 token。
  if (idp.organization.region !== currentRegion()) {
    return { ok: false, status: 401, reason: 'wrong-region' };
  }
  return { ok: true, idpId: idp.id, orgId: idp.orgId, orgSlug: idp.organization.slug };
}

/**
 * SCIM 错误信封每 RFC 7644 §3.12。`scimType` 字段是
 * 可选的，仅在验证错误上设置 — 其他一切是
 * 裸露的 `{ status, detail }`。
 */
export function scimError(status: number, detail: string, extra?: { scimType?: string }): Response {
  return Response.json(
    {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: String(status),
      detail,
      ...(extra?.scimType ? { scimType: extra.scimType } : {}),
    },
    { status, headers: { 'Content-Type': 'application/scim+json; charset=utf-8' } },
  );
}

/** SCIM 200/201 信封与正确的 Content-Type。 */
export function scimJson(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { 'Content-Type': 'application/scim+json; charset=utf-8' },
  });
}
