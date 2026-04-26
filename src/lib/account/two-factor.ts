'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { env } from '@/env';
import { recordAudit } from '@/lib/audit';
import { update as updateAuthSession } from '@/lib/auth';
import {
  base32Encode,
  buildOtpauthUri,
  decryptSecret,
  encryptSecret,
  findBackupCodeHash,
  generateBackupCodes,
  generateTotpSecret,
  verifyTotp,
} from '@/lib/auth/2fa-crypto';
import { requireActiveOrg, requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { sendTwoFactorEnabledEmail, sendTwoFactorDisabledEmail } from '@/lib/auth/email-flows';

/**
 * RFC 0002 PR-2 — 2FA enroll / verify / disable / regenerate flows.
 *
 * Two state diagrams to keep in mind:
 *
 *   TwoFactorSecret row          User.twoFactorEnabled
 *   ──────────────────           ─────────────────────
 *   absent                  ↔    false   (never enrolled OR disabled)
 *   present, enabledAt=null ↔    false   (enroll started, awaiting confirm)
 *   present, enabledAt set  ↔    true    (active)
 *
 *   JWT token.tfa_pending
 *   ─────────────────────
 *   undefined / false  →  no challenge required (user has no 2FA)
 *   true               →  user must hit /login/2fa next; the page calls
 *                         `verifyTfaForCurrentSessionAction` to clear it.
 */

const codeSchema = z.object({
  code: z
    .string()
    .min(6)
    .max(20)
    .transform((s) => s.replace(/\s+/g, '')),
});

const verifySchema = z.object({
  code: z.string().min(6).max(20),
});

const TFA_ISSUER = 'Kitora';

/**
 * Step 1 of enrollment. Generates a fresh secret + 10 backup codes, persists
 * them in a half-enrolled state (`enabledAt = null`), and returns the values
 * the UI needs to render (otpauth URI for QR / manual entry, plain backup
 * codes — shown once and never again).
 */
export async function enrollStartAction() {
  const me = await requireUser();
  if (!me.email) {
    return { ok: false as const, error: 'no-email' as const };
  }

  // Already fully enabled? Bail; force disable-then-re-enable so an
  // attacker who hijacks a logged-in session can't silently rotate the
  // TOTP secret of an existing 2FA setup.
  const existing = await prisma.twoFactorSecret.findUnique({ where: { userId: me.id } });
  if (existing?.enabledAt) {
    return { ok: false as const, error: 'already-enabled' as const };
  }

  const secret = generateTotpSecret();
  const enc = encryptSecret(me.id, secret);
  const { plain: backupPlain, hashes: backupHashes } = generateBackupCodes();

  await prisma.twoFactorSecret.upsert({
    where: { userId: me.id },
    create: {
      userId: me.id,
      encSecret: enc,
      backupHashes,
      enabledAt: null,
    },
    update: {
      // Re-roll an in-progress enrollment if the user clicks "Enable" twice.
      encSecret: enc,
      backupHashes,
      enabledAt: null,
    },
  });

  const otpauthUri = buildOtpauthUri({
    secret,
    accountLabel: me.email,
    issuer: TFA_ISSUER,
  });

  return {
    ok: true as const,
    otpauthUri,
    // Base32 secret string for manual entry — derived from the same buffer
    // we just encrypted, so we don't need to decrypt-roundtrip here.
    secret: base32Encode(secret),
    backupCodes: backupPlain,
  };
}

/**
 * Step 2 of enrollment. The user types the first 6-digit code from their
 * authenticator; we verify against the half-enrolled secret and, on
 * success, flip `enabledAt` + `User.twoFactorEnabled` in a single tx.
 *
 * Note: backup codes were already shown in step 1 — we don't re-emit them
 * here. UI flow: enrollStart → display secret + backup codes → enrollConfirm.
 */
export async function enrollConfirmAction(input: z.infer<typeof codeSchema>) {
  const me = await requireUser();
  const parsed = codeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const row = await prisma.twoFactorSecret.findUnique({ where: { userId: me.id } });
  if (!row) {
    return { ok: false as const, error: 'not-enrolled' as const };
  }
  if (row.enabledAt) {
    return { ok: false as const, error: 'already-enabled' as const };
  }

  const secret = decryptSecret(me.id, Buffer.from(row.encSecret));
  if (!verifyTotp(secret, parsed.data.code)) {
    return { ok: false as const, error: 'wrong-code' as const };
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.twoFactorSecret.update({
      where: { userId: me.id },
      data: { enabledAt: now },
    }),
    prisma.user.update({
      where: { id: me.id },
      data: { twoFactorEnabled: true },
    }),
  ]);

  // Mark the current session as already-verified so the jwt callback doesn't
  // immediately set `tfa_pending = true` and bounce the user to /login/2fa.
  // They just proved possession of the TOTP secret in this very request —
  // re-challenging them right after enrollment is jarring and wrong.
  await updateAuthSession({ tfa: 'verified' } as unknown as Parameters<
    typeof updateAuthSession
  >[0]).catch(() => {});

  await recordAudit({
    actorId: me.id,
    action: '2fa.enabled',
    target: me.id,
  });
  // Notify the account owner — defensive in case this enrollment was
  // initiated by someone who hijacked an authenticated session.
  if (me.email) {
    void sendTwoFactorEnabledEmail({
      id: me.id,
      email: me.email,
      name: me.name ?? null,
    }).catch((err) => logger.error({ err, userId: me.id }, '2fa-enabled-email-failed'));
  }

  revalidatePath('/settings');
  return { ok: true as const };
}

/**
 * Disable 2FA. Requires a fresh TOTP / backup code so a stolen session
 * can't trivially turn it off. Wipes the secret + backup codes outright;
 * a re-enable goes through enrollStart again.
 */
export async function disableAction(input: z.infer<typeof codeSchema>) {
  const me = await requireActiveOrg();
  const parsed = codeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const row = await prisma.twoFactorSecret.findUnique({
    where: { userId: me.userId },
    select: { encSecret: true, enabledAt: true, backupHashes: true },
  });
  if (!row?.enabledAt) {
    return { ok: false as const, error: 'not-enabled' as const };
  }

  const matchedByTotp = verifyTotp(
    decryptSecret(me.userId, Buffer.from(row.encSecret)),
    parsed.data.code,
  );
  const matchedHash = matchedByTotp ? null : findBackupCodeHash(parsed.data.code, row.backupHashes);
  if (!matchedByTotp && !matchedHash) {
    return { ok: false as const, error: 'wrong-code' as const };
  }

  await prisma.$transaction([
    prisma.twoFactorSecret.delete({ where: { userId: me.userId } }),
    prisma.user.update({
      where: { id: me.userId },
      data: { twoFactorEnabled: false },
    }),
  ]);

  await updateAuthSession({}).catch(() => {});

  await recordAudit({
    actorId: me.userId,
    orgId: me.orgId,
    action: '2fa.disabled',
    target: me.userId,
  });

  // Look up email separately — we deliberately keep requireActiveOrg lean.
  const u = await prisma.user.findUnique({
    where: { id: me.userId },
    select: { email: true, name: true },
  });
  if (u?.email) {
    void sendTwoFactorDisabledEmail({
      id: me.userId,
      email: u.email,
      name: u.name,
    }).catch((err) => logger.error({ err, userId: me.userId }, '2fa-disabled-email-failed'));
  }

  revalidatePath('/settings');
  return { ok: true as const };
}

/**
 * Regenerate the 10 one-time backup codes. Returns the fresh plaintext list
 * so the UI can display them once. Old codes are immediately invalidated.
 */
export async function regenerateBackupCodesAction() {
  const me = await requireUser();
  const row = await prisma.twoFactorSecret.findUnique({ where: { userId: me.id } });
  if (!row?.enabledAt) {
    return { ok: false as const, error: 'not-enabled' as const };
  }

  const { plain, hashes } = generateBackupCodes();
  await prisma.twoFactorSecret.update({
    where: { userId: me.id },
    data: { backupHashes: hashes },
  });

  await recordAudit({
    actorId: me.id,
    action: '2fa.backup_regenerated',
    target: me.id,
  });

  return { ok: true as const, backupCodes: plain };
}

/**
 * Called from `/login/2fa` after the user types their code. On success:
 *   1. Update the JWT so `tfa_pending` becomes false.
 *   2. Bump `lastUsedAt` on the secret row (audit-friendly).
 *   3. If a backup code was used, delete it from the array (single-use).
 *
 * This is the only path that flips `tfa_pending` — the page itself doesn't
 * touch claims. Returns `ok: true` so the caller can redirect.
 */
export async function verifyTfaForCurrentSessionAction(input: z.infer<typeof verifySchema>) {
  const me = await requireUser();
  const parsed = verifySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' as const };
  }

  const row = await prisma.twoFactorSecret.findUnique({
    where: { userId: me.id },
    select: { encSecret: true, enabledAt: true, backupHashes: true },
  });
  if (!row?.enabledAt) {
    return { ok: false as const, error: 'not-enabled' as const };
  }

  const matchedByTotp = verifyTotp(
    decryptSecret(me.id, Buffer.from(row.encSecret)),
    parsed.data.code,
  );
  const matchedHash = matchedByTotp ? null : findBackupCodeHash(parsed.data.code, row.backupHashes);
  if (!matchedByTotp && !matchedHash) {
    logger.warn({ userId: me.id }, '2fa-challenge-failed');
    return { ok: false as const, error: 'wrong-code' as const };
  }

  if (matchedHash) {
    // Single-use: drop the matched hash from the array.
    await prisma.twoFactorSecret.update({
      where: { userId: me.id },
      data: {
        backupHashes: (row.backupHashes as string[]).filter((h: string) => h !== matchedHash),
        lastUsedAt: new Date(),
      },
    });
  } else {
    await prisma.twoFactorSecret.update({
      where: { userId: me.id },
      data: { lastUsedAt: new Date() },
    });
  }

  // Flip the JWT claim. `unstable_update` re-runs the jwt callback with
  // `trigger='update'`; we read the flag back inside index.ts and clear
  // tfa_pending there. The session payload accepts arbitrary keys at
  // runtime — cast through `unknown` so we don't have to widen the typed
  // Session shape just to plumb a transient flag.
  await updateAuthSession({ tfa: 'verified' } as unknown as Parameters<
    typeof updateAuthSession
  >[0]);

  return { ok: true as const, env: env.NEXT_PUBLIC_APP_URL };
}
