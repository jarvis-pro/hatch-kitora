import 'server-only';

import { OrgRole } from '@prisma/client';

import { prisma } from '@/lib/db';

import { stripe } from './client';

/**
 * 返回组织的 Stripe 客户 ID，如果需要则创建一个。
 *
 * PR-4 契约：`Organization.stripeCustomerId` 是单一事实来源。
 * 我们只查找 OWNER 成员资格来获取新 Stripe 客户的联系电子邮件/名称
 *（仅供显示——规范的所有者是组织本身）。
 */
export async function getOrCreateStripeCustomerId(orgId: string): Promise<string> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      stripeCustomerId: true,
      memberships: {
        where: { role: OrgRole.OWNER },
        take: 1,
        select: {
          user: {
            select: { id: true, email: true, name: true },
          },
        },
      },
    },
  });
  if (!org) {
    throw new Error(`Organization ${orgId} not found`);
  }
  if (org.stripeCustomerId) {
    return org.stripeCustomerId;
  }

  const owner = org.memberships[0]?.user;

  const customer = await stripe.customers.create({
    email: owner?.email ?? undefined,
    name: owner?.name ?? org.name,
    metadata: {
      orgId,
      ownerUserId: owner?.id ?? '',
    },
  });

  await prisma.organization.update({
    where: { id: orgId },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}
