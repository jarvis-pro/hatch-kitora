/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { createHash, randomBytes } from 'node:crypto';

import { PrismaClient, type User } from '@prisma/client';
import bcrypt from 'bcryptjs';

/**
 * Tests share a single Prisma client. Use the same `DATABASE_URL` the app
 * uses — *but ideally point at a dedicated test DB* by exporting
 * `DATABASE_URL` for a throwaway schema before invoking `pnpm test:e2e`.
 *
 * Tests are responsible for cleaning up their own rows; we don't truncate
 * tables wholesale because that would clobber dev data if someone wires
 * the wrong URL.
 */
export const prisma = new PrismaClient();

export interface CreateTestUserOptions {
  email?: string;
  name?: string;
  password?: string;
  role?: 'USER' | 'ADMIN';
  emailVerified?: boolean;
}

export interface TestUser extends User {
  /** Plaintext password (only available to tests because we set it). */
  rawPassword: string;
}

export function uniqueEmail(prefix = 'kitora-e2e'): string {
  return `${prefix}+${randomBytes(6).toString('hex')}@example.com`;
}

export async function createTestUser(opts: CreateTestUserOptions = {}): Promise<TestUser> {
  const password = opts.password ?? 'Test1234!';
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      email: opts.email ?? uniqueEmail(),
      name: opts.name ?? 'E2E Tester',
      passwordHash,
      role: opts.role ?? 'USER',
      emailVerified: opts.emailVerified ? new Date() : null,
    },
  });
  return Object.assign(user, { rawPassword: password });
}

/** Cascading delete via the FK chain — works for the User row only. */
export async function deleteUser(id: string) {
  try {
    await prisma.user.delete({ where: { id } });
  } catch {
    // Already gone — fine for cleanup paths.
  }
}

export function hashRawToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Issue a raw token + persist its hash. Returns the raw — caller will plant
 *  it in the URL the test visits. */
export async function issuePasswordResetToken(userId: string): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: hashRawToken(raw),
      expires: new Date(Date.now() + 30 * 60_000),
    },
  });
  return raw;
}

export async function issueEmailVerificationToken(userId: string): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash: hashRawToken(raw),
      expires: new Date(Date.now() + 24 * 60 * 60_000),
    },
  });
  return raw;
}
