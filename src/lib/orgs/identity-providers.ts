'use server';

import { OrgRole, SsoProtocol } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { removeConnections, syncOidcConnection, syncSamlConnection } from '@/lib/sso/connection';
import { validateEmailDomain } from '@/lib/sso/domain';
import { encryptOidcSecret, generateScimToken } from '@/lib/sso/secret';

/**
 * RFC 0004 PR-1 — IdentityProvider CRUD + SCIM token 生命周期。
 *
 * 授权模型：
 *
 *   - 每个操作通过 `orgSlug` 解析 org，然后检查成员身份。
 *   - OWNER / ADMIN 可以创建/更新非 `enforceForLogin` 字段并
 *     管理 SCIM token。
 *   - 仅 OWNER 可以翻转 `enforceForLogin = true`（将 org 锁定在
 *     IdP 后面）— 这个决定足够具有破坏性，要在最高
 *     角色处把守。
 *
 * 密钥生命周期：
 *
 *   - OIDC `client_secret` 明文仅通过 `create` / `update` 流入。
 *     我们用刚创建的行 id 作为盐对其进行 HKDF + AES-GCM，然后
 *     持久化。要轮换，调用者在另一个更新中重新提交密钥 —
 *     没有"解密并显示给我"的路径。
 *   - SCIM token 明文仅在 `rotateScimToken` 时返回一次。
 *     DB 保留 `scimTokenHash` + `scimTokenPrefix` 用于查找 + UI。
 */

const orgScopeSchema = z.object({
  orgSlug: z.string().min(1).max(80),
});

const protocolSchema = z.nativeEnum(SsoProtocol);

const baseShape = {
  name: z.string().min(1).max(120),
  emailDomains: z.array(z.string().min(1).max(253)).max(20).default([]),
  defaultRole: z.nativeEnum(OrgRole).default(OrgRole.MEMBER),
  enforceForLogin: z.boolean().default(false),
  enabledAt: z.union([z.date(), z.null()]).optional(),
};

const createSchema = orgScopeSchema.extend({
  protocol: protocolSchema,
  ...baseShape,
  // SAML — 完整的 metadata XML
  samlMetadata: z
    .string()
    .max(64 * 1024)
    .optional(),
  // OIDC
  oidcIssuer: z.string().url().max(512).optional(),
  oidcClientId: z.string().max(255).optional(),
  oidcClientSecret: z.string().max(512).optional(),
});

const updateSchema = orgScopeSchema.extend({
  id: z.string().min(1).max(64),
  name: baseShape.name.optional(),
  emailDomains: baseShape.emailDomains.optional(),
  defaultRole: baseShape.defaultRole.optional(),
  enforceForLogin: baseShape.enforceForLogin.optional(),
  enabledAt: baseShape.enabledAt,
  samlMetadata: z
    .string()
    .max(64 * 1024)
    .nullable()
    .optional(),
  oidcIssuer: z.string().url().max(512).nullable().optional(),
  oidcClientId: z.string().max(255).nullable().optional(),
  oidcClientSecret: z.string().max(512).optional(), // 如果提供，则重新加密
  scimEnabled: z.boolean().optional(),
});

const idScopeSchema = orgScopeSchema.extend({
  id: z.string().min(1).max(64),
});

// ─── auth helpers ───────────────────────────────────────────────────────────

interface OrgGate {
  orgId: string;
  role: OrgRole;
}

async function requireSsoManager(userId: string, orgSlug: string): Promise<OrgGate | null> {
  const membership = await prisma.membership.findFirst({
    where: {
      userId,
      organization: { slug: orgSlug },
      role: { in: [OrgRole.OWNER, OrgRole.ADMIN] },
    },
    select: { orgId: true, role: true },
  });
  return membership ? { orgId: membership.orgId, role: membership.role } : null;
}

function normalizeDomains(input: readonly string[]): string[] | { error: string; bad: string } {
  const out: string[] = [];
  for (const raw of input) {
    const verdict = validateEmailDomain(raw);
    if (!verdict.ok) {
      return { error: verdict.reason, bad: raw };
    }
    if (!out.includes(verdict.domain)) out.push(verdict.domain);
  }
  return out;
}

function assertProtocolFields(input: {
  protocol: SsoProtocol;
  samlMetadata?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
}): { ok: true } | { ok: false; reason: string } {
  if (input.protocol === SsoProtocol.SAML) {
    if (!input.samlMetadata || !input.samlMetadata.includes('<')) {
      return { ok: false, reason: 'saml-metadata-required' };
    }
    return { ok: true };
  }
  // OIDC
  if (!input.oidcIssuer || !input.oidcClientId || !input.oidcClientSecret) {
    return { ok: false, reason: 'oidc-fields-required' };
  }
  return { ok: true };
}

// ─── actions ────────────────────────────────────────────────────────────────

export type CreateIdentityProviderInput = z.input<typeof createSchema>;

interface CreateResult {
  ok: true;
  id: string;
}
interface ErrorResult {
  ok: false;
  error: string;
  message?: string;
}

export async function createIdentityProviderAction(
  input: CreateIdentityProviderInput,
): Promise<CreateResult | ErrorResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input', message: parsed.error.message };

  const me = await requireUser().catch(() => null);
  if (!me) return { ok: false, error: 'unauthorized' };

  const gate = await requireSsoManager(me.id, parsed.data.orgSlug);
  if (!gate) return { ok: false, error: 'forbidden' };

  // 仅限 OWNER 的标志。
  if (parsed.data.enforceForLogin && gate.role !== OrgRole.OWNER) {
    return { ok: false, error: 'enforce-owner-only' };
  }

  const protoCheck = assertProtocolFields(parsed.data);
  if (!protoCheck.ok) return { ok: false, error: protoCheck.reason };

  const domains = normalizeDomains(parsed.data.emailDomains);
  if (!Array.isArray(domains)) {
    return { ok: false, error: `invalid-domain:${domains.error}`, message: domains.bad };
  }

  // 两步写入：插入行以分配 id，然后用该 id 作为 HKDF 盐加密
  // OIDC 密钥。镜像 `WebhookEndpoint` 创建流程（RFC 0003 PR-2）。
  const created = await prisma.identityProvider.create({
    data: {
      orgId: gate.orgId,
      protocol: parsed.data.protocol,
      name: parsed.data.name,
      emailDomains: domains,
      defaultRole: parsed.data.defaultRole,
      enforceForLogin: parsed.data.enforceForLogin,
      enabledAt: parsed.data.enabledAt ?? null,
      samlMetadata: parsed.data.samlMetadata ?? null,
      oidcIssuer: parsed.data.oidcIssuer ?? null,
      oidcClientId: parsed.data.oidcClientId ?? null,
    },
    select: { id: true },
  });

  if (parsed.data.protocol === SsoProtocol.OIDC && parsed.data.oidcClientSecret) {
    await prisma.identityProvider.update({
      where: { id: created.id },
      data: {
        oidcClientSecret: encryptOidcSecret(created.id, parsed.data.oidcClientSecret),
      },
    });
  }

  // 推送到 Jackson。**创建时尽力而为** — 行以草稿形式出生
  // （`enabledAt = null`），登录查询已经跳过草稿行，所以
  // 这里的同步失败无法将半配置的 IdP 交给真实用户。OWNER
  // 将在 UI 中看到该行；稍后翻转 `enabledAt` 走更新路径，
  // 该路径**确实**将同步失败视为致命 — 所以
  // 格式错误的元数据 XML 会在破坏登录之前在那里浮出。
  //
  // 为什么不在失败时回滚 prisma 行：格式错误的 SAML 元数据是
  // 最常见的配置错误（通常是缺少 X509Certificate
  // 块），强制用户重新填充整个表单只是为了重试
  // 是不友好的 UX。保留该行，让他们 PATCH 坏字段。
  try {
    if (parsed.data.protocol === SsoProtocol.SAML && parsed.data.samlMetadata) {
      await syncSamlConnection({
        orgSlug: parsed.data.orgSlug,
        samlMetadata: parsed.data.samlMetadata,
      });
    } else if (
      parsed.data.protocol === SsoProtocol.OIDC &&
      parsed.data.oidcIssuer &&
      parsed.data.oidcClientId &&
      parsed.data.oidcClientSecret
    ) {
      await syncOidcConnection({
        orgSlug: parsed.data.orgSlug,
        oidcIssuer: parsed.data.oidcIssuer,
        oidcClientId: parsed.data.oidcClientId,
        oidcClientSecret: parsed.data.oidcClientSecret,
      });
    }
  } catch (err) {
    logger.warn(
      { err, providerId: created.id },
      'sso-jackson-sync-failed-on-create-row-kept-as-draft',
    );
  }

  await recordAudit({
    actorId: me.id,
    orgId: gate.orgId,
    action: 'sso.idp_created',
    target: created.id,
    metadata: {
      protocol: parsed.data.protocol,
      enforceForLogin: parsed.data.enforceForLogin,
      enabledAt: parsed.data.enabledAt?.toISOString() ?? null,
    },
  });

  revalidatePath(`/settings/organization/sso`);
  revalidatePath(`/${parsed.data.orgSlug}/settings/organization/sso`);
  return { ok: true, id: created.id };
}

export async function updateIdentityProviderAction(
  input: z.input<typeof updateSchema>,
): Promise<{ ok: true } | ErrorResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input', message: parsed.error.message };

  const me = await requireUser().catch(() => null);
  if (!me) return { ok: false, error: 'unauthorized' };

  const gate = await requireSsoManager(me.id, parsed.data.orgSlug);
  if (!gate) return { ok: false, error: 'forbidden' };

  // 在对 `enforceForLogin` 进行角色检查之前消除行的歧义。
  const existing = await prisma.identityProvider.findFirst({
    where: { id: parsed.data.id, orgId: gate.orgId },
    select: { id: true, protocol: true, enforceForLogin: true },
  });
  if (!existing) return { ok: false, error: 'not-found' };

  // OWNER 对 enforce 标志的把守，无论新旧值如何
  //（我们也阻止 ADMIN 从*清除*它 — 同样量级的决定）。
  if (parsed.data.enforceForLogin !== undefined && gate.role !== OrgRole.OWNER) {
    return { ok: false, error: 'enforce-owner-only' };
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.defaultRole !== undefined) data.defaultRole = parsed.data.defaultRole;
  if (parsed.data.enforceForLogin !== undefined) data.enforceForLogin = parsed.data.enforceForLogin;
  if (parsed.data.enabledAt !== undefined) data.enabledAt = parsed.data.enabledAt;
  if (parsed.data.scimEnabled !== undefined) data.scimEnabled = parsed.data.scimEnabled;

  if (parsed.data.emailDomains !== undefined) {
    const domains = normalizeDomains(parsed.data.emailDomains);
    if (!Array.isArray(domains)) {
      return { ok: false, error: `invalid-domain:${domains.error}`, message: domains.bad };
    }
    data.emailDomains = domains;
  }

  if (existing.protocol === SsoProtocol.SAML) {
    if (parsed.data.samlMetadata !== undefined) {
      if (parsed.data.samlMetadata === null) {
        return { ok: false, error: 'saml-metadata-required' };
      }
      if (!parsed.data.samlMetadata.includes('<')) {
        return { ok: false, error: 'saml-metadata-required' };
      }
      data.samlMetadata = parsed.data.samlMetadata;
    }
  } else {
    // OIDC
    if (parsed.data.oidcIssuer !== undefined) data.oidcIssuer = parsed.data.oidcIssuer;
    if (parsed.data.oidcClientId !== undefined) data.oidcClientId = parsed.data.oidcClientId;
    if (parsed.data.oidcClientSecret) {
      data.oidcClientSecret = encryptOidcSecret(existing.id, parsed.data.oidcClientSecret);
    }
  }

  await prisma.identityProvider.update({
    where: { id: existing.id },
    data,
  });

  // 如果影响连接的任何字段发生了变化，重新同步 Jackson。
  // 便宜：加载当前行 + 整体重新推送。只有
  // SAML metadata / OIDC 字段对 Jackson 真正重要，但 upsert
  // 是幂等的，所以我们只是总是发送。
  if (
    data.samlMetadata !== undefined ||
    data.oidcIssuer !== undefined ||
    data.oidcClientId !== undefined ||
    data.oidcClientSecret !== undefined
  ) {
    try {
      const fresh = await prisma.identityProvider.findUniqueOrThrow({
        where: { id: existing.id },
        select: {
          protocol: true,
          samlMetadata: true,
          oidcIssuer: true,
          oidcClientId: true,
        },
      });
      if (fresh.protocol === SsoProtocol.SAML && fresh.samlMetadata) {
        await syncSamlConnection({
          orgSlug: parsed.data.orgSlug,
          samlMetadata: fresh.samlMetadata,
        });
      } else if (
        fresh.protocol === SsoProtocol.OIDC &&
        // OIDC client secret 刚在此 PATCH 中提供（我们永不重新
        // 解密，因为轮换需要调用者重新提交）。
        parsed.data.oidcClientSecret &&
        fresh.oidcIssuer &&
        fresh.oidcClientId
      ) {
        await syncOidcConnection({
          orgSlug: parsed.data.orgSlug,
          oidcIssuer: fresh.oidcIssuer,
          oidcClientId: fresh.oidcClientId,
          oidcClientSecret: parsed.data.oidcClientSecret,
        });
      }
    } catch (err) {
      logger.error({ err, providerId: existing.id }, 'sso-jackson-sync-failed');
      return {
        ok: false,
        error: 'jackson-sync-failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  await recordAudit({
    actorId: me.id,
    orgId: gate.orgId,
    action: 'sso.idp_updated',
    target: existing.id,
    metadata: {
      changedKeys: Object.keys(data),
    },
  });

  revalidatePath(`/settings/organization/sso`);
  revalidatePath(`/${parsed.data.orgSlug}/settings/organization/sso`);
  return { ok: true };
}

export async function deleteIdentityProviderAction(
  input: z.input<typeof idScopeSchema>,
): Promise<{ ok: true } | ErrorResult> {
  const parsed = idScopeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input', message: parsed.error.message };

  const me = await requireUser().catch(() => null);
  if (!me) return { ok: false, error: 'unauthorized' };

  const gate = await requireSsoManager(me.id, parsed.data.orgSlug);
  if (!gate) return { ok: false, error: 'forbidden' };

  // 在 enforceForLogin 开启时阻止删除 — 操作者必须显式
  // 先取消强制，否则我们会将 org 锁定在任何密码回退之外。
  const existing = await prisma.identityProvider.findFirst({
    where: { id: parsed.data.id, orgId: gate.orgId },
    select: { id: true, enforceForLogin: true },
  });
  if (!existing) return { ok: false, error: 'not-found' };
  if (existing.enforceForLogin) {
    return { ok: false, error: 'enforce-still-on' };
  }

  await prisma.identityProvider.delete({ where: { id: existing.id } });

  // 尽力而为的 Jackson 清理。如果该行从未被同步（例如，之前
  // 同步失败），`removeConnections` 是无操作。我们吞没错误，
  // 所以死亡的 Jackson 连接不会阻止删除用户面对的行。
  try {
    await removeConnections(parsed.data.orgSlug);
  } catch (err) {
    logger.error({ err, providerId: existing.id }, 'sso-jackson-cleanup-failed');
  }

  await recordAudit({
    actorId: me.id,
    orgId: gate.orgId,
    action: 'sso.idp_deleted',
    target: existing.id,
  });

  revalidatePath(`/settings/organization/sso`);
  revalidatePath(`/${parsed.data.orgSlug}/settings/organization/sso`);
  return { ok: true };
}

interface RotateScimResult {
  ok: true;
  /** 明文 SCIM token — 向调用者显示一次，然后丢弃。 */
  token: string;
  prefix: string;
}

export async function rotateScimTokenAction(
  input: z.input<typeof idScopeSchema>,
): Promise<RotateScimResult | ErrorResult> {
  const parsed = idScopeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input', message: parsed.error.message };

  const me = await requireUser().catch(() => null);
  if (!me) return { ok: false, error: 'unauthorized' };

  const gate = await requireSsoManager(me.id, parsed.data.orgSlug);
  if (!gate) return { ok: false, error: 'forbidden' };

  const existing = await prisma.identityProvider.findFirst({
    where: { id: parsed.data.id, orgId: gate.orgId },
    select: { id: true },
  });
  if (!existing) return { ok: false, error: 'not-found' };

  const fresh = generateScimToken();
  await prisma.identityProvider.update({
    where: { id: existing.id },
    data: {
      scimTokenHash: fresh.hash,
      scimTokenPrefix: fresh.prefix,
      scimEnabled: true,
    },
  });

  await recordAudit({
    actorId: me.id,
    orgId: gate.orgId,
    action: 'sso.scim_token_rotated',
    target: existing.id,
    metadata: { tokenPrefix: fresh.prefix },
  });

  logger.info({ providerId: existing.id, prefix: fresh.prefix }, 'sso-scim-token-rotated');

  revalidatePath(`/settings/organization/sso`);
  revalidatePath(`/${parsed.data.orgSlug}/settings/organization/sso`);
  return { ok: true, token: fresh.plain, prefix: fresh.prefix };
}
