// RFC 0007 §4.6 — Cross-method 2FA state evaluation.
//
// `User.twoFactorEnabled` was introduced by RFC 0002 PR-2 as a denorm
// flag for "user has TOTP". RFC 0007 widens the meaning: it's true iff
// the user has *any* second factor — TOTP enabled OR at least one
// WebAuthnCredential row. Callers that flip TOTP or passkey state on
// or off route through `recomputeTwoFactorEnabled()` so the column
// stays in sync without hardcoding the OR each spot.
//
// Note: RFC 0007 PR-2 only wires this from the passkey add / delete
// paths — the TOTP enable / disable server actions still hardcode true
// / false respectively (their pre-RFC-0007 behaviour). That's correct
// for the TOTP-only majority of users; the corner case of a user who
// has BOTH TOTP and a passkey getting `twoFactorEnabled = false` after
// disabling TOTP is a known smell, fixable by retrofitting those two
// call sites to use this helper. RFC 0007 §4.6 calls it out.

import 'server-only';

import type { Prisma, PrismaClient } from '@prisma/client';

import { prisma } from '@/lib/db';

/** Pure decision: given the post-change factor flags, should the column be true? */
export function shouldTwoFactorBeEnabled(opts: {
  totpEnabled: boolean;
  passkeyCount: number;
}): boolean {
  return opts.totpEnabled || opts.passkeyCount > 0;
}

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Re-evaluate `User.twoFactorEnabled` for `userId` based on the *current*
 * state of `TwoFactorSecret` + `WebAuthnCredential`. Writes the new value
 * iff it differs from the existing one. Returns the post-write value.
 *
 * Pass an explicit `tx` when calling from inside a `prisma.$transaction`
 * — the helper joins the transaction instead of opening a fresh
 * connection (avoids reading stale data committed mid-flight).
 */
export async function recomputeTwoFactorEnabled(userId: string, tx: Tx = prisma): Promise<boolean> {
  const [totp, passkeyCount, current] = await Promise.all([
    tx.twoFactorSecret.findUnique({
      where: { userId },
      select: { enabledAt: true },
    }),
    tx.webAuthnCredential.count({ where: { userId } }),
    tx.user.findUnique({
      where: { id: userId },
      select: { twoFactorEnabled: true },
    }),
  ]);

  const next = shouldTwoFactorBeEnabled({
    totpEnabled: totp?.enabledAt != null,
    passkeyCount,
  });

  if (current?.twoFactorEnabled !== next) {
    await tx.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: next },
    });
  }
  return next;
}
