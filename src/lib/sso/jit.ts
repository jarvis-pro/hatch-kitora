// 注意：这里刻意*不*设置 'server-only' — SSO 回调路由（服务器端）
// 和 e2e 套件都使用这个。可传递 `@/lib/db` 仅是 Node，所以
// 意外的客户端打包无论如何都会失败。
//
// 实时用户/成员配置。在 Jackson 验证 SAML 响应后从 SSO ACS
// 回调调用，我们有稳定的 `(providerId, providerSubject, email)` 三元组。
//
// 解析优先级：
//
//   1. `(providerId, providerSubject)` — 最强绑定；幸存
//      IdP 的电子邮件轮换。
//   2. `email` — 首次登录的回退（没有成员行携带
//      providerSubject 尚且）并且有机用户已经在
//      org 启用 SSO 之前拥有 Kitora 账户。
//   3. 都不是 — 以 IdP 的 `defaultRole` 创建新鲜 User + Membership。

import type { OrgRole } from '@prisma/client';

import { recordAudit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { currentRegion } from '@/lib/region';

export interface JitInput {
  /** IdP 行 id（来自 `IdentityProvider`）。 */
  providerId: string;
  /** SAML NameID 或 OIDC `sub` — 在同一 IdP 中稳定。 */
  providerSubject: string;
  /** IdP 断言的电子邮件。我们信任 IdP 的验证。 */
  email: string;
  /** IdP 声明中的可选显示名称。 */
  name?: string | null;
  /** IdP 所属的 Org id。 */
  orgId: string;
  /** `IdentityProvider.defaultRole` 用于新成员。 */
  defaultRole: OrgRole;
}

export interface JitResult {
  userId: string;
  /** 如果我们在此调用中创建了 User 行为真。 */
  userCreated: boolean;
  /** 如果我们在此调用中创建了（或恢复了）Membership 行为真。 */
  membershipCreated: boolean;
}

export async function provisionSsoUser(input: JitInput): Promise<JitResult> {
  // 快速路径：由已绑定 SSO 成员资格重新登录。
  const bound = await prisma.membership.findFirst({
    where: { providerId: input.providerId, providerSubject: input.providerSubject },
    select: { userId: true, deletedAt: true, orgId: true, id: true },
  });
  if (bound) {
    if (bound.deletedAt) {
      // SCIM 之前已软删除此行。在新鲜 SSO 登录时重新激活 —
      // IT 显然不想让用户被锁定，因为他们仍在
      // IdP 的应用分配中。
      await prisma.membership.update({
        where: { id: bound.id },
        data: { deletedAt: null },
      });
    }
    return { userId: bound.userId, userCreated: false, membershipCreated: false };
  }

  // 路径 B：按电子邮件现有 User 行，但尚无 SSO 绑定。
  // RFC 0005 — SSO 按区域绑定：IdP 属于在此堆栈
  // 的区域中存在的 Org（SSO start handler 强制执行这个），
  // 所以匹配的遗留账户也必须。复合（email、region）密钥
  // 无歧义返回正确的行。
  const region = currentRegion();
  const existingUser = await prisma.user.findUnique({
    where: { email_region: { email: input.email.toLowerCase(), region } },
    select: { id: true },
  });
  if (existingUser) {
    // Upsert 他们在 SSO org 中的成员资格，附加提供者绑定。
    const result = await prisma.membership.upsert({
      where: { orgId_userId: { orgId: input.orgId, userId: existingUser.id } },
      create: {
        orgId: input.orgId,
        userId: existingUser.id,
        role: input.defaultRole,
        providerId: input.providerId,
        providerSubject: input.providerSubject,
      },
      update: {
        // 不要降级现有角色 — 仅附加 SSO 绑定。
        providerId: input.providerId,
        providerSubject: input.providerSubject,
        deletedAt: null,
      },
      select: { id: true },
    });
    logger.info(
      { userId: existingUser.id, providerId: input.providerId },
      'sso-bound-existing-user',
    );
    return { userId: existingUser.id, userCreated: false, membershipCreated: !!result };
  }

  // 路径 C：全新用户。我们信任 IdP 断言的电子邮件并立即戳
  // `emailVerified` — 通过 SSO 满足与我们魔法链接相同的
  // "他们拥有此收件箱"承诺。
  const created = await prisma.user.create({
    data: {
      email: input.email.toLowerCase(),
      name: input.name ?? null,
      emailVerified: new Date(),
      // RFC 0005 — JIT 创建的用户与进程驻留在同一区域。
      // IdP 按区域绑定（其父 Org 携带 `region`），所以这是
      // 唯一正确的值。
      region,
      memberships: {
        create: {
          orgId: input.orgId,
          role: input.defaultRole,
          providerId: input.providerId,
          providerSubject: input.providerSubject,
        },
      },
    },
    select: { id: true },
  });

  await recordAudit({
    actorId: null, // 系统操作 — IdP 权威
    orgId: input.orgId,
    action: 'sso.jit_user_created',
    target: created.id,
    metadata: {
      providerId: input.providerId,
      email: input.email.toLowerCase(),
    },
  });

  return { userId: created.id, userCreated: true, membershipCreated: true };
}
