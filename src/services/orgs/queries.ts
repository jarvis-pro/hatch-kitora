// 注意：这里故意*不*是 `'server-only'` —— 本模块被 src/lib/webhooks/cron.ts
// 传递性引用，而 cron.ts 又被 Playwright e2e 测试在进程内直接 import 跑
// runWebhookCronTick。一旦本文件加 `'server-only'`，e2e 跑测试运行器（被 React
// 视作客户端环境）时会立即抛 "This module cannot be imported from a Client
// Component module"。透传的 `@/lib/db`（prisma）依赖仍然防止意外的客户端捆绑。

import { prisma } from '@/lib/db';
import type { Prisma } from '@/lib/db';

/**
 * Membership 软删除查询 helper。
 *
 * 背景：`Membership.deletedAt` 是 RFC 0004 §SCIM 引入的软删除字段 —— SCIM PATCH
 * `active: false` 把它打成「停用但保留行」，后续 `active: true` 就地复活。SCIM
 * DELETE 与手动从 UI 移除走真正的硬删除（`prisma.membership.delete`），不留痕迹。
 *
 * 现状：超过 20 个 callsite 直接调 `prisma.membership.findFirst/findMany/...`，
 * 绝大多数**没有**显式 `deletedAt: null` 过滤。结果：被软删除的成员仍可能：
 *   - 通过 `api-org-gate` 鉴权访问 org 资源；
 *   - 在 webhook 自动禁用通知邮件的 OWNER/ADMIN 收件人列表里；
 *   - 出现在 `listMembershipsForUser` / `getActiveMembership` 等会话切换 helper 里。
 *
 * 本文件提供「活跃成员」语义的统一 helper —— 任何鉴权 / 通知 / 计费场景应只调
 * 这里，把对软删除字段的认知集中到一个文件。允许已存在的 callsite 渐进迁移。
 *
 * SCIM reactivate 路径（`src/app/api/scim/v2/Users/[id]/route.ts` 等）显式需要
 * 看到软删除行，**不要**走这里 —— 那条路径的语义就是「恢复软删除」，必须直接读
 * `prisma.membership.findFirst({ where: { ..., deletedAt: { not: null } } })`。
 */

/**
 * `prisma.membership.findFirst` 的薄封装：自动追加 `deletedAt: null`。
 *
 * 用于「这个 user 在这个 org 里还活着吗」类查询。
 */
export function findActiveMembership<T extends Prisma.MembershipFindFirstArgs>(
  args: T,
): Promise<Prisma.MembershipGetPayload<T> | null> {
  return prisma.membership.findFirst({
    ...args,
    where: { ...(args.where ?? {}), deletedAt: null },
  } as T) as Promise<Prisma.MembershipGetPayload<T> | null>;
}

/**
 * `prisma.membership.findMany` 的薄封装：自动追加 `deletedAt: null`。
 *
 * 用于通知邮件 / 列表展示 / 计数等场景，过滤掉已软删除的成员。
 */
export function listActiveMemberships<T extends Prisma.MembershipFindManyArgs>(
  args: T,
): Promise<Prisma.MembershipGetPayload<T>[]> {
  return prisma.membership.findMany({
    ...args,
    where: { ...(args.where ?? {}), deletedAt: null },
  } as T) as Promise<Prisma.MembershipGetPayload<T>[]>;
}

/**
 * `prisma.membership.count` 的薄封装：自动追加 `deletedAt: null`。
 */
export function countActiveMemberships(args: Prisma.MembershipCountArgs = {}): Promise<number> {
  return prisma.membership.count({
    ...args,
    where: { ...(args.where ?? {}), deletedAt: null },
  });
}
