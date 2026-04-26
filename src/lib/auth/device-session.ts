// NOTE: deliberately *not* `'server-only'` here — Playwright e2e tests
// drive `createDeviceSession` / `hashSid` in-process via the SSO flow's
// `issueSsoSession` helper. The transitive `@/lib/db` (prisma) + `node:crypto`
// imports already gate accidental client bundling.
import { createHash, randomBytes } from 'node:crypto';

import { prisma } from '@/lib/db';

/**
 * Active sessions plumbing (RFC 0002 PR-1).
 *
 * Each issued JWT carries a random `sid` claim — sha256(sid) is the row key
 * in `DeviceSession`. We never store the raw sid; that lives only in the
 * signed JWT cookie.
 *
 * The Node-side jwt() callback in `src/lib/auth/index.ts` calls
 * `validateDeviceSession()` on every request — a missing or revoked row
 * forces a re-login. `signOutEverywhere()` and per-row revocation both flip
 * `revokedAt`, so a user can manage their fleet of devices from the UI.
 */

/** Generate a fresh raw sid suitable for embedding in a JWT claim. */
export function generateSid(): string {
  return randomBytes(32).toString('base64url');
}

/** Hash a raw sid for DB storage / lookup. */
export function hashSid(rawSid: string): string {
  return createHash('sha256').update(rawSid).digest('hex');
}

interface CreateInput {
  userId: string;
  rawSid: string;
  userAgent?: string | null;
  ip?: string | null;
}

/** Persist a new DeviceSession row at sign-in. Returns the row id. */
export async function createDeviceSession(input: CreateInput): Promise<string> {
  const row = await prisma.deviceSession.create({
    data: {
      userId: input.userId,
      sidHash: hashSid(input.rawSid),
      userAgent: input.userAgent?.slice(0, 1024) ?? null,
      ip: input.ip ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

interface ValidateResult {
  ok: boolean;
  sidHash: string;
}

/**
 * Validate that a sid still maps to an unrevoked row. Called from the jwt()
 * callback on every request — keep it fast (one indexed unique lookup).
 *
 * Also opportunistically refreshes `lastSeenAt` with a 60s throttle so the
 * sessions list stays meaningful without turning this row into a hot-spot.
 */
export async function validateDeviceSession(rawSid: string): Promise<ValidateResult> {
  const sidHash = hashSid(rawSid);
  const row = await prisma.deviceSession.findUnique({
    where: { sidHash },
    select: { revokedAt: true },
  });
  if (!row || row.revokedAt) {
    return { ok: false, sidHash };
  }
  // Fire-and-forget the throttled lastSeenAt update. Errors here must never
  // block auth — at worst the UI shows a slightly stale timestamp.
  void touchDeviceSession(sidHash);
  return { ok: true, sidHash };
}

const TOUCH_THROTTLE_MS = 60_000;

/**
 * Throttled `lastSeenAt` update. `updateMany` with a `lastSeenAt < cutoff`
 * filter makes this naturally idempotent under concurrency — only the
 * request that crosses the cutoff actually writes.
 */
async function touchDeviceSession(sidHash: string): Promise<void> {
  const cutoff = new Date(Date.now() - TOUCH_THROTTLE_MS);
  try {
    await prisma.deviceSession.updateMany({
      where: { sidHash, lastSeenAt: { lt: cutoff } },
      data: { lastSeenAt: new Date() },
    });
  } catch {
    // Swallow — see comment above.
  }
}

/** Revoke a single session by row id. Returns true if a row was actually revoked. */
export async function revokeDeviceSessionById(userId: string, id: string): Promise<boolean> {
  const result = await prisma.deviceSession.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}

/**
 * Revoke every active session for a user. Used by `signOutEverywhereAction`,
 * `changePasswordAction`, and the future account-deletion flow alongside the
 * `User.sessionVersion` bump.
 */
export async function revokeAllDeviceSessions(userId: string): Promise<number> {
  const result = await prisma.deviceSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export interface DeviceSessionView {
  id: string;
  userAgent: string | null;
  ip: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  current: boolean;
}

/**
 * List a user's active sessions for the settings UI. The caller's own
 * sidHash is passed so we can flag the "current" row — the UI hides the
 * revoke button for it (no foot-guns).
 */
export async function listActiveDeviceSessions(
  userId: string,
  currentSidHash: string | null,
): Promise<DeviceSessionView[]> {
  const rows = await prisma.deviceSession.findMany({
    where: { userId, revokedAt: null },
    orderBy: { lastSeenAt: 'desc' },
    select: {
      id: true,
      sidHash: true,
      userAgent: true,
      ip: true,
      lastSeenAt: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    userAgent: r.userAgent,
    ip: r.ip,
    lastSeenAt: r.lastSeenAt,
    createdAt: r.createdAt,
    current: currentSidHash !== null && r.sidHash === currentSidHash,
  }));
}
