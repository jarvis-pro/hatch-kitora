import 'server-only';

import { OrgRole } from '@prisma/client';

import { prisma } from '@/lib/db';

import { stripe } from './client';

/**
 * Returns the Stripe customer id for an organization, creating one if
 * needed.
 *
 * PR-2 contract:
 *   - Source of truth is `Organization.stripeCustomerId`.
 *   - During the migration window, if the org has no customer but its OWNER
 *     user still has one (i.e. PR-1 backfill ran but a checkout happened
 *     before this code path saw the org), we move it across without
 *     creating a duplicate Stripe customer.
 *   - When we have to create a fresh Stripe customer, we **dual-write**
 *     the new id back to both the org and the OWNER user, so PR-4 can drop
 *     `User.stripeCustomerId` later without leaving stale state.
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
            select: { id: true, email: true, name: true, stripeCustomerId: true },
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

  // 兜底：OWNER 上还有 stripeCustomerId 但 Org 上没有 → 把它搬过来，不重建。
  if (owner?.stripeCustomerId) {
    await prisma.organization.update({
      where: { id: orgId },
      data: { stripeCustomerId: owner.stripeCustomerId },
    });
    return owner.stripeCustomerId;
  }

  // 真·首次：建 Stripe customer，metadata 同时挂 org / user 便于客服反查。
  const customer = await stripe.customers.create({
    email: owner?.email ?? undefined,
    name: owner?.name ?? org.name,
    metadata: {
      orgId,
      userId: owner?.id ?? '',
    },
  });

  // 双写：新建的 customer id 同时写到 Org 和 OWNER User（PR-4 删 User 列时
  // 不会丢数据 — 因为读取永远先看 Org）。
  await prisma.$transaction([
    prisma.organization.update({
      where: { id: orgId },
      data: { stripeCustomerId: customer.id },
    }),
    ...(owner?.id && !owner.stripeCustomerId
      ? [
          prisma.user.update({
            where: { id: owner.id },
            data: { stripeCustomerId: customer.id },
          }),
        ]
      : []),
  ]);

  return customer.id;
}
