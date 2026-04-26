import 'server-only';

import { OrgRole } from '@prisma/client';

import { prisma } from '@/lib/db';

import { stripe } from './client';

/**
 * Returns the Stripe customer id for an organization, creating one if
 * needed.
 *
 * PR-4 contract: `Organization.stripeCustomerId` is the single source of
 * truth. We look up the OWNER membership only to grab a contact email/name
 * for the new Stripe customer (cosmetic — the canonical owner is the org).
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
