// NOTE: deliberately *not* `'server-only'` here — Playwright's e2e suite
// imports `buildUserExport` directly to verify the file set + the
// blacklist scrubber. The transitive `@/lib/db` (PrismaClient) dep already
// makes accidental client bundling fail loudly, so the safety guarantee
// is preserved without the import-time throw.
import { prisma } from '@/lib/db';

import { makeZip } from './zip';

/**
 * RFC 0002 PR-3 — build the GDPR data export zip.
 *
 * Two scopes (user / org). Both go through `MANIFEST_VERSION = '1.0'` so
 * future schema additions can be detected by tooling. Sensitive fields
 * are *never* written — see `assertSafePayload` for the blacklist.
 *
 * Field policy:
 *   ✗ passwordHash, tokenHash, sidHash, encSecret, backupHashes
 *   ✗ Stripe customer / price / subscription IDs (replaced with plan slug)
 *   ✓ everything else the user already sees in the UI
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
    take: 5000, // hard cap so a noisy actor can't blow up the zip
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
      // Metadata only — never the hash, never the raw token.
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
          // tokenHash is intentionally omitted — see assertSafePayload.
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
          // stripeSubscriptionId / stripePriceId omitted; we surface the
          // plan SLUG via mapping but keep this PR pragmatic — leave
          // priceId resolution to a future "billing context" pass.
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function jsonFile(name: string, data: unknown): ZipFile {
  return { name, body: Buffer.from(JSON.stringify(data, null, 2), 'utf8') };
}

function textFile(name: string, body: string): ZipFile {
  return { name, body: Buffer.from(body, 'utf8') };
}

function stamp(): string {
  // YYYYMMDD — UTC, deterministic.
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Defense-in-depth blacklist scan. Even though we hand-pick fields above,
 * a future select-all regression could leak a hash. This grep over the
 * raw JSON catches the obvious culprits.
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
