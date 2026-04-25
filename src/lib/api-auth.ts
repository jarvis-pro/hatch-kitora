import 'server-only';

import { createHash } from 'node:crypto';

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

export interface ApiTokenPrincipal {
  userId: string;
  tokenId: string;
}

const HEADER_RE = /^Bearer\s+([A-Za-z0-9_-]{20,})$/;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Validate the `Authorization: Bearer <token>` header against the ApiToken
 * table. Returns null on any failure (bad header, unknown / revoked / expired
 * token). On success, side-effects: bumps `lastUsedAt`.
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
    select: { id: true, userId: true, revokedAt: true, expiresAt: true },
  });
  if (!token) return null;
  if (token.revokedAt) return null;
  if (token.expiresAt && token.expiresAt.getTime() < Date.now()) return null;

  // Best-effort touch — never block the request on this.
  prisma.apiToken
    .update({
      where: { id: token.id },
      data: { lastUsedAt: new Date() },
    })
    .catch((err) => logger.warn({ err, tokenId: token.id }, 'apitoken-touch-failed'));

  return { userId: token.userId, tokenId: token.id };
}
