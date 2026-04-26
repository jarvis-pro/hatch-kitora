// RFC 0007 PR-2 — POST /api/auth/webauthn/register/verify
//
// Step 2 of credential registration. Receives the `RegistrationResponseJSON`
// from `navigator.credentials.create()`, verifies the signature against
// the challenge minted in step 1, and persists a new `WebAuthnCredential`
// row. Same transaction recomputes `User.twoFactorEnabled` so adding a
// passkey to a previously-no-2FA account flips the flag in one shot.

import { NextResponse } from 'next/server';

import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { requireUser } from '@/lib/auth/session';
import { recomputeTwoFactorEnabled } from '@/lib/auth/two-factor-state';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { consumeChallenge } from '@/lib/webauthn/challenge';
import { verifyRegistration } from '@/lib/webauthn/verify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const inputSchema = z.object({
  /**
   * Verbatim `RegistrationResponseJSON` returned by
   * `@simplewebauthn/browser`'s `startRegistration()`. We don't shape-
   * check the inner fields here — the SDK's verify helper does that.
   */
  response: z.unknown(),
  /** User-given label for the credential, e.g. "MacBook Touch ID". */
  name: z.string().min(1).max(80),
});

export async function POST(request: Request) {
  const me = await requireUser().catch(() => null);
  if (!me) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid-input' }, { status: 400 });
  }

  const challenge = await consumeChallenge(me.id);
  if (!challenge) {
    return NextResponse.json({ error: 'challenge-expired' }, { status: 400 });
  }

  const verified = await verifyRegistration({
    response: parsed.data.response as RegistrationResponseJSON,
    expectedChallenge: challenge,
  });
  if (!verified) {
    return NextResponse.json({ error: 'verification-failed' }, { status: 400 });
  }

  // Single tx: insert credential row + recompute twoFactorEnabled.
  const credential = await prisma.$transaction(async (tx) => {
    const created = await tx.webAuthnCredential.create({
      data: {
        userId: me.id,
        credentialId: verified.credentialId,
        publicKey: verified.publicKey,
        counter: verified.counter,
        transports: verified.transports,
        deviceType: verified.deviceType,
        backedUp: verified.backedUp,
        name: parsed.data.name,
      },
      select: { id: true, credentialId: true, deviceType: true },
    });

    await recomputeTwoFactorEnabled(me.id, tx);
    return created;
  });

  await recordAudit({
    actorId: me.id,
    action: 'webauthn.credential_added',
    target: me.id,
    metadata: {
      credentialDbId: credential.id,
      deviceType: credential.deviceType,
      name: parsed.data.name,
    },
  });

  logger.info(
    { userId: me.id, credentialDbId: credential.id, deviceType: credential.deviceType },
    'webauthn-register-success',
  );

  return NextResponse.json({ id: credential.id, ok: true });
}
