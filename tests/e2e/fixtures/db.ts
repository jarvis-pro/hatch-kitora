/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { createHash, randomBytes } from 'node:crypto';

import { PrismaClient, type User } from '@prisma/client';
import bcrypt from 'bcryptjs';

/**
 * 所有 test 共享同一个 Prisma 客户端。使用与应用相同的 `DATABASE_URL` ——
 * 但强烈建议在运行 `pnpm test:e2e` 前导出一个独立的测试 DB 连接串。
 *
 * 每个 test 负责清理自己写入的行；不做全表 truncate，
 * 因为误用了错误 URL 时那会清掉开发数据。
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
  /** 明文密码（仅测试可用，因为是我们自己设置的）。 */
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

/** 通过外键级联删除 User 行及其所有关联数据。 */
export async function deleteUser(id: string) {
  try {
    await prisma.user.delete({ where: { id } });
  } catch {
    // 行已不存在 —— 清理路径下正常忽略。
  }
}

export function hashRawToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * 签发一个原始 token 并持久化其哈希。返回原始值 ——
 * 调用方会把它植入测试访问的 URL 中。
 */
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

// ---------------------------------------------------------------------------
// 组织测试辅助函数（RFC-0001）
// ---------------------------------------------------------------------------

export interface CreateOrgOptions {
  slug?: string;
  name?: string;
  ownerId: string;
}

/** 创建一个非 personal 的 org，并为 `ownerId` 建立 OWNER membership。 */
export async function createOrgWithOwner(opts: CreateOrgOptions) {
  const slug = opts.slug ?? `acme-${randomBytes(4).toString('hex')}`;
  const org = await prisma.organization.create({
    data: { slug, name: opts.name ?? 'Acme Inc' },
  });
  await prisma.membership.create({
    data: { orgId: org.id, userId: opts.ownerId, role: 'OWNER' },
  });
  return org;
}

export async function deleteOrg(id: string) {
  try {
    await prisma.organization.delete({ where: { id } });
  } catch {
    // 行已不存在 —— 清理路径下正常忽略。
  }
}

/** 直接签发一个 org 邀请。返回原始 token，用于构造邀请 URL。 */
export async function issueOrgInvitationToken(opts: {
  orgId: string;
  email: string;
  role: 'ADMIN' | 'MEMBER';
  invitedBy: string;
}): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await prisma.invitation.create({
    data: {
      orgId: opts.orgId,
      email: opts.email,
      role: opts.role,
      tokenHash: hashRawToken(raw),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      invitedBy: opts.invitedBy,
    },
  });
  return raw;
}
