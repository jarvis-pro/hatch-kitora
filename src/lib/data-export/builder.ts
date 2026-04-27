// 注意：这里故意*没有* `'server-only'` — Playwright 的 e2e 套件
// 直接导入 `buildUserExport` 来验证文件集 + 黑名单清理器。
// 传递的 `@/lib/db` (PrismaClient) 依赖项已经使意外的客户端
// 打包失败发声，因此安全保证在没有导入时抛出的情况下被保留。
import { prisma } from '@/lib/db';

import { makeZip } from './zip';

/**
 * RFC 0002 PR-3 — 构建 GDPR 数据导出 zip。
 *
 * 两个范围（user / org）。两者都通过 `MANIFEST_VERSION = '1.0'` 进行，
 * 以便工具可以检测到未来的模式添加。敏感字段*从不*被写入 —
 * 请参阅 `assertSafePayload` 了解黑名单。
 *
 * 字段策略：
 *   ✗ passwordHash, tokenHash, sidHash, encSecret, backupHashes
 *   ✗ Stripe customer / price / subscription IDs（用计划 slug 替换）
 *   ✓ 用户已在 UI 中看到的所有其他内容
 */

const MANIFEST_VERSION = '1.0';

interface ZipFile {
  name: string;
  body: Buffer;
}

export async function buildUserExport(userId: string): Promise<{
  filename: string;
  body: Buffer;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      image: true,
      role: true,
      locale: true,
      twoFactorEnabled: true,
      createdAt: true,
      updatedAt: true,
      accounts: {
        select: {
          provider: true,
          providerAccountId: true,
          type: true,
        },
      },
      memberships: {
        select: {
          role: true,
          joinedAt: true,
          organization: { select: { slug: true, name: true } },
        },
      },
      apiTokens: {
        select: {
          id: true,
          name: true,
          prefix: true,
          createdAt: true,
          lastUsedAt: true,
          expiresAt: true,
          revokedAt: true,
          organization: { select: { slug: true } },
        },
      },
      deviceSessions: {
        select: {
          id: true,
          userAgent: true,
          ip: true,
          lastSeenAt: true,
          createdAt: true,
          revokedAt: true,
        },
      },
    },
  });
  if (!user) throw new Error('user-not-found');

  const auditLogs = await prisma.auditLog.findMany({
    where: { actorId: userId },
    orderBy: { createdAt: 'desc' },
    take: 5000, // 硬盖，所以嘈杂的参与者不能吹爆 zip
    select: {
      id: true,
      action: true,
      target: true,
      orgId: true,
      metadata: true,
      ip: true,
      createdAt: true,
    },
  });

  const dataExports = await prisma.dataExportJob.findMany({
    where: { userId, scope: 'USER' },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      sizeBytes: true,
      expiresAt: true,
      createdAt: true,
      completedAt: true,
    },
  });

  const profile = {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    image: user.image,
    role: user.role,
    locale: user.locale,
    twoFactorEnabled: user.twoFactorEnabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };

  const files: ZipFile[] = [
    jsonFile('manifest.json', {
      version: MANIFEST_VERSION,
      scope: 'USER',
      generatedAt: new Date().toISOString(),
      subject: { kind: 'user', id: user.id, email: user.email },
      files: [
        'profile.json',
        'accounts.json',
        'memberships.json',
        'api-tokens.json',
        'audit-as-actor.json',
        'device-sessions.json',
        'data-exports.json',
        'README.md',
      ],
    }),
    jsonFile('profile.json', profile),
    jsonFile('accounts.json', user.accounts),
    jsonFile(
      'memberships.json',
      user.memberships.map((m) => ({
        role: m.role,
        joinedAt: m.joinedAt,
        org: m.organization,
      })),
    ),
    jsonFile(
      'api-tokens.json',
      // 仅元数据 — 从不散列，从不原始令牌。
      user.apiTokens.map((t) => ({
        id: t.id,
        name: t.name,
        prefix: t.prefix,
        org: t.organization,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        expiresAt: t.expiresAt,
        revokedAt: t.revokedAt,
      })),
    ),
    jsonFile('audit-as-actor.json', auditLogs),
    jsonFile('device-sessions.json', user.deviceSessions),
    jsonFile('data-exports.json', dataExports),
    textFile('README.md', userReadme(user.email)),
  ];

  assertSafePayload(files);

  return {
    filename: `kitora-export-${user.id}-${stamp()}.zip`,
    body: makeZip(files),
  };
}

export async function buildOrgExport(orgId: string): Promise<{
  filename: string;
  body: Buffer;
}> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      slug: true,
      name: true,
      image: true,
      createdAt: true,
      updatedAt: true,
      memberships: {
        select: {
          role: true,
          joinedAt: true,
          user: { select: { id: true, email: true, name: true } },
        },
      },
      invitations: {
        select: {
          id: true,
          email: true,
          role: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
          createdAt: true,
          // tokenHash 被故意省略 — 请参阅 assertSafePayload。
        },
      },
      apiTokens: {
        select: {
          id: true,
          name: true,
          prefix: true,
          createdAt: true,
          lastUsedAt: true,
          expiresAt: true,
          revokedAt: true,
          user: { select: { id: true, email: true } },
        },
      },
      subscriptions: {
        select: {
          id: true,
          status: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          createdAt: true,
          updatedAt: true,
          // stripeSubscriptionId / stripePriceId 被省略；我们通过映射
          // 展示计划 SLUG 但保持这个 PR 实用 —
          // 将 priceId 解析留给未来的"账单上下文"传递。
        },
      },
    },
  });
  if (!org) throw new Error('org-not-found');

  const auditLogs = await prisma.auditLog.findMany({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
    take: 10000,
    select: {
      id: true,
      actorId: true,
      action: true,
      target: true,
      metadata: true,
      ip: true,
      createdAt: true,
    },
  });

  const files: ZipFile[] = [
    jsonFile('manifest.json', {
      version: MANIFEST_VERSION,
      scope: 'ORG',
      generatedAt: new Date().toISOString(),
      subject: { kind: 'org', id: org.id, slug: org.slug },
      files: [
        'organization.json',
        'members.json',
        'invitations.json',
        'api-tokens.json',
        'subscriptions.json',
        'audit-org-scope.json',
        'README.md',
      ],
    }),
    jsonFile('organization.json', {
      id: org.id,
      slug: org.slug,
      name: org.name,
      image: org.image,
      createdAt: org.createdAt,
      updatedAt: org.updatedAt,
    }),
    jsonFile(
      'members.json',
      org.memberships.map((m) => ({
        role: m.role,
        joinedAt: m.joinedAt,
        user: m.user,
      })),
    ),
    jsonFile('invitations.json', org.invitations),
    jsonFile(
      'api-tokens.json',
      org.apiTokens.map((t) => ({
        id: t.id,
        name: t.name,
        prefix: t.prefix,
        owner: t.user,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        expiresAt: t.expiresAt,
        revokedAt: t.revokedAt,
      })),
    ),
    jsonFile('subscriptions.json', org.subscriptions),
    jsonFile('audit-org-scope.json', auditLogs),
    textFile('README.md', orgReadme(org.slug)),
  ];

  assertSafePayload(files);

  return {
    filename: `kitora-org-export-${org.slug}-${stamp()}.zip`,
    body: makeZip(files),
  };
}

// ─── 辅助函数 ────────────────────────────────────────────────────────────────

function jsonFile(name: string, data: unknown): ZipFile {
  return { name, body: Buffer.from(JSON.stringify(data, null, 2), 'utf8') };
}

function textFile(name: string, body: string): ZipFile {
  return { name, body: Buffer.from(body, 'utf8') };
}

function stamp(): string {
  // YYYYMMDD — UTC，确定性。
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * 纵深防御黑名单扫描。即使我们在上面手选字段，
 * 未来的 select-all 回归也可能泄露散列。
 * 这个对原始 JSON 的 grep 捕获明显的嫌疑人。
 */
const BLACKLIST = [
  'passwordHash',
  'tokenHash',
  'sidHash',
  'encSecret',
  'backupHashes',
  'stripeCustomerId',
  'stripeSubscriptionId',
  'stripePriceId',
];

function assertSafePayload(files: readonly ZipFile[]): void {
  for (const f of files) {
    if (!f.name.endsWith('.json')) continue;
    const text = f.body.toString('utf8');
    for (const term of BLACKLIST) {
      if (text.includes(`"${term}"`)) {
        throw new Error(`data-export-leak: ${term} present in ${f.name}`);
      }
    }
  }
}

function userReadme(email: string | null): string {
  return [
    '# Kitora — Your Personal Data Export',
    '',
    `Generated for: ${email ?? '(no email)'}`,
    `Schema version: ${MANIFEST_VERSION}`,
    '',
    '## Files',
    '',
    '- `profile.json` — your User row (name, email, locale, role, 2FA status).',
    '- `accounts.json` — OAuth providers linked to this account.',
    '- `memberships.json` — every organization you belong to and your role.',
    '- `api-tokens.json` — metadata for tokens you created (no secrets).',
    '- `audit-as-actor.json` — audit log entries where you were the actor.',
    '- `device-sessions.json` — historical and active device sessions.',
    '- `data-exports.json` — your past export requests.',
    '',
    '## Your GDPR rights',
    '',
    'Under GDPR Articles 15 (access) and 20 (portability), you have the right',
    'to obtain a copy of your personal data in a machine-readable format —',
    'this archive satisfies that request. To request correction (Art. 16),',
    'restriction (Art. 18), or erasure (Art. 17), use the Settings UI or',
    'contact support.',
  ].join('\n');
}

function orgReadme(slug: string): string {
  return [
    `# Kitora — Organization Export: ${slug}`,
    '',
    `Schema version: ${MANIFEST_VERSION}`,
    '',
    '## Files',
    '',
    '- `organization.json` — org metadata (name, slug, timestamps).',
    '- `members.json` — members and their roles.',
    '- `invitations.json` — pending and historical invitations (no token hashes).',
    '- `api-tokens.json` — org-scoped API tokens (metadata only).',
    '- `subscriptions.json` — subscription status / billing periods.',
    '- `audit-org-scope.json` — audit log entries scoped to this org.',
    '',
    'Stripe customer / price / subscription IDs are intentionally omitted.',
    'Plan information is reflected by the subscription status field; for',
    'invoice history, use the Stripe customer portal.',
  ].join('\n');
}
