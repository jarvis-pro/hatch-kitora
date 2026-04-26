import 'server-only';

import { createHash } from 'node:crypto';

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

import { getPersonalOrgIdForUser } from '@/lib/auth/session';

export interface ApiTokenPrincipal {
  userId: string;
  /**
   * Organization the bearer is operating within. PR-2 contract: every API
   * call carries an org context; one token is bound to exactly one org
   * (RFC-0001 §9 decision). During the migration window, tokens created
   * before the orgId column existed fall back to the user's personal org.
   */
  orgId: string;
  tokenId: string;
}

const HEADER_RE = /^Bearer\s+([A-Za-z0-9_-]{20,})$/;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Validate the `Authorization: Bearer <token>` header against the ApiToken
 * table. Returns null on any failure (bad header, unknown / revoked / expired
 * token, no resolvable org). On success, side-effects: bumps `lastUsedAt`.
 *
 * Token format we accept: `kitora_<random>`. The `kitora_` prefix is purely
 * for human eyeballing; the validator only checks length / charset.
 */
export async function authenticateBearer(request: Request): Promise<ApiTokenPrincipal | null> {
  const header = request.headers.get('authorization');
  if (!header) return null;

  const match = HEADER_RE.exec(header.trim());
  if (!match) return null;

  // First capture group is the token characters; non-null because the regex
  // requires it to match.
  const raw = match[1] as string;
  const tokenHash = hashToken(raw);

  const token = await prisma.apiToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, orgId: true, revokedAt: true, expiresAt: true },
  });
  if (!token) return null;
  if (token.revokedAt) return null;
  if (token.expiresAt && token.expiresAt.getTime() < Date.now()) return null;

  // Resolve org: token.orgId is the source of truth; pre-PR-1 tokens may
  // still be null (the backfill should have caught these but we defend
  // anyway), in which case we fall back to the owner's personal org.
  const orgId = token.orgId ?? (await getPersonalOrgIdForUser(token.userId));
  if (!orgId) {
    // No way to resolve a scope — refuse rather than silently broaden access.
    logger.warn({ tokenId: token.id, userId: token.userId }, 'apitoken-no-org');
    return null;
  }

  // Best-effort touch — never block the request on this.
  prisma.apiToken
    .update({
      where: { id: token.id },
      data: { lastUsedAt: new Date() },
    })
    .catch((err) => logger.warn({ err, tokenId: token.id }, 'apitoken-touch-failed'));

  return { userId: token.userId, orgId, tokenId: token.id };
}
